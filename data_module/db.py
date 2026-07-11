from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import uuid
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

import httpx

from .config import Settings
from .pipeline.normalization import stable_hash

logger = logging.getLogger(__name__)

_CAMPAIGN_ELIGIBLE_CATEGORIES = frozenset(
    {"scam_report", "impersonation_abuse"}
)
_DURABLE_CAMPAIGN_INDICATOR_TYPES = frozenset(
    {
        "bank_account",
        "phone",
        "email",
        "domain",
        "social_account",
        "qr_payload",
        "transaction_reference",
        "media_hash",
    }
)


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _campaign_label(anchor_indicator_key: str, scam_types: Sequence[str]) -> str:
    """Generate a safe provisional English label without overwriting analyst edits."""

    kind, _, value = str(anchor_indicator_key).partition("|")
    type_label = {
        "bank_account": "Bank account",
        "phone": "Phone",
        "email": "Email",
        "domain": "Domain",
        "social_account": "Social account",
        "qr_payload": "QR payload",
        "transaction_reference": "Transaction reference",
        "media_hash": "Shared media",
        "message_template": "Message pattern",
    }.get(kind, "Indicator")
    if kind in {"bank_account", "phone", "transaction_reference"}:
        display_value = "••••" + value[-4:]
    elif len(value) > 36:
        display_value = value[:33] + "…"
    else:
        display_value = value
    scam_type = str(next(iter(scam_types or []), "")).strip().casefold()
    scam_parts = [part for part in scam_type.split("_") if part]
    if (
        not scam_parts
        or len(scam_parts) > 5
        or any(len(part) < 2 for part in scam_parts)
        or len(scam_type) > 48
    ):
        scam_label = "Suspected Scam"
    else:
        scam_label = " ".join(scam_parts).title()
    return "{} · {} {}".format(scam_label, type_label, display_value).strip()


def _validate_campaign_cluster(cluster: Mapping[str, Any]) -> None:
    """Reject non-scam or phrase-only derivative clusters before persistence."""

    document_count = int(cluster.get("document_count") or 0)
    category_counts = list(cluster.get("category_counts") or [])
    categories = {
        str(row.get("category") or "")
        for row in category_counts
        if isinstance(row, Mapping)
    }
    categorized_documents = sum(
        int(row.get("document_count") or 0)
        for row in category_counts
        if isinstance(row, Mapping)
    )
    anchor_key = str(cluster.get("anchor_indicator_key") or "")
    anchor_kind = anchor_key.partition("|")[0]
    memberships = list(cluster.get("memberships") or [])
    membership_ids = [
        str(row.get("document_id") or "")
        for row in memberships
        if isinstance(row, Mapping)
    ]

    if (
        document_count < 2
        or not categories
        or not categories.issubset(_CAMPAIGN_ELIGIBLE_CATEGORIES)
        or categorized_documents != document_count
        or anchor_kind not in _DURABLE_CAMPAIGN_INDICATOR_TYPES
        or len(membership_ids) != document_count
        or len(set(membership_ids)) != document_count
        or any(not document_id for document_id in membership_ids)
    ):
        raise ValueError(
            "Campaign persistence requires a complete scam-only cluster with a durable anchor"
        )


class SupabaseRestClient:
    """Small PostgREST client covering only the operations this MVP needs."""

    def __init__(
        self,
        url: str,
        service_key: str,
        client: Optional[httpx.Client] = None,
    ) -> None:
        if not service_key:
            raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is required")
        self.base_url = url.rstrip("/") + "/rest/v1"
        self.client = client or httpx.Client(timeout=30.0)
        self.headers = {
            "apikey": service_key,
            "Authorization": "Bearer " + service_key,
            "Content-Type": "application/json",
        }

    def _request(
        self,
        method: str,
        table: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        payload: Any = None,
        prefer: Optional[str] = None,
    ) -> Any:
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        response = self.client.request(
            method,
            f"{self.base_url}/{table}",
            params=params,
            json=payload,
            headers=headers,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase {method} {table} failed ({response.status_code}): "
                f"{response.text[:1000]}"
            )
        if not response.content:
            return []
        return response.json()

    def select(
        self,
        table: str,
        *,
        columns: str = "*",
        filters: Optional[Mapping[str, str]] = None,
        order: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {"select": columns}
        params.update(filters or {})
        if order:
            params["order"] = order
        if limit is not None:
            if limit < 0:
                raise ValueError("limit cannot be negative")
            params["limit"] = str(limit)
        if offset is not None:
            if offset < 0:
                raise ValueError("offset cannot be negative")
            params["offset"] = str(offset)
        return self._request("GET", table, params=params)

    def select_paginated(
        self,
        table: str,
        *,
        columns: str = "*",
        filters: Optional[Mapping[str, str]] = None,
        order: Optional[str] = None,
        limit: Optional[int] = None,
        page_size: int = 1000,
        unique_key: str = "id",
    ) -> List[Dict[str, Any]]:
        """Read beyond PostgREST's per-request row cap.

        Offset pagination is made deterministic by appending ``unique_key`` as a
        tie-breaker to the requested ordering. Rows are also de-duplicated by that
        key so a row moving across a page boundary during a live refresh cannot be
        returned twice.
        """

        if limit is not None and limit < 0:
            raise ValueError("limit cannot be negative")
        if not 1 <= page_size <= 1000:
            raise ValueError("page_size must be between 1 and 1000")
        if not unique_key.strip():
            raise ValueError("unique_key is required for deterministic pagination")
        if limit == 0:
            return []

        requested_order = str(order or "").strip()
        order_fields = {
            clause.strip().split(".", 1)[0]
            for clause in requested_order.split(",")
            if clause.strip()
        }
        deterministic_order = requested_order
        if unique_key not in order_fields:
            deterministic_order = ",".join(
                value for value in (requested_order, unique_key + ".asc") if value
            )

        rows: List[Dict[str, Any]] = []
        seen: set[Any] = set()
        offset = 0
        while limit is None or len(rows) < limit:
            request_limit = page_size
            if limit is not None:
                request_limit = min(request_limit, limit - len(rows))
            page = self.select(
                table,
                columns=columns,
                filters=filters,
                order=deterministic_order,
                limit=request_limit,
                offset=offset,
            )
            if not page:
                break

            offset += len(page)
            added = 0
            for row in page:
                identity = row.get(unique_key)
                if identity is None:
                    raise RuntimeError(
                        "Paginated Supabase selection must include " + unique_key
                    )
                if identity in seen:
                    continue
                seen.add(identity)
                rows.append(row)
                added += 1
                if limit is not None and len(rows) >= limit:
                    break

            if len(page) < request_limit:
                break
            if added == 0:
                raise RuntimeError("Supabase pagination made no progress")

        return rows

    def insert(self, table: str, payload: Any) -> List[Dict[str, Any]]:
        return self._request(
            "POST", table, payload=payload, prefer="return=representation"
        )

    def update(
        self, table: str, payload: Mapping[str, Any], filters: Mapping[str, str]
    ) -> List[Dict[str, Any]]:
        return self._request(
            "PATCH",
            table,
            params=filters,
            payload=payload,
            prefer="return=representation",
        )

    def delete(
        self, table: str, filters: Mapping[str, str]
    ) -> List[Dict[str, Any]]:
        return self._request(
            "DELETE",
            table,
            params=filters,
            prefer="return=representation",
        )

    def upsert(
        self,
        table: str,
        payload: Any,
        *,
        on_conflict: str,
    ) -> List[Dict[str, Any]]:
        return self._request(
            "POST",
            table,
            params={"on_conflict": on_conflict},
            payload=payload,
            prefer="resolution=merge-duplicates,return=representation",
        )


class SupabaseRepository:
    def __init__(
        self,
        settings: Settings,
        rest: Optional[SupabaseRestClient] = None,
    ) -> None:
        self.settings = settings
        self.rest = rest or SupabaseRestClient(
            settings.supabase_url, settings.supabase_service_role_key
        )

    def _select_paginated(self, table: str, **kwargs: Any) -> List[Dict[str, Any]]:
        """Use paginated reads while retaining lightweight repository test doubles."""

        select_paginated = getattr(self.rest, "select_paginated", None)
        if callable(select_paginated):
            return select_paginated(table, **kwargs)
        return self.rest.select(table, **kwargs)

    def create_job(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        params = dict(payload.get("parameters") or payload)
        row = {
            "name": payload.get("name") or params.get("name") or "Untitled crawl",
            "mode": payload.get("mode") or params.get("mode") or "backfill",
            "status": "queued",
            "current_stage": "queued",
            "parameters": params,
            "agent_budget": int(
                params.get("agent_record_budget", params.get("agent_record_limit", 5))
            ),
            "next_run_at": utcnow(),
        }
        return self.rest.insert("crawl_jobs", row)[0]

    def list_jobs(self, limit: int = 100) -> List[Dict[str, Any]]:
        return self.rest.select(
            "crawl_jobs", order="created_at.desc", limit=limit
        )

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        rows = self.rest.select(
            "crawl_jobs", filters={"id": "eq." + job_id}, limit=1
        )
        return rows[0] if rows else None

    def list_runnable_jobs(self, limit: int = 20) -> List[Dict[str, Any]]:
        rows = self.rest.select(
            "crawl_jobs",
            filters={"status": "in.(queued,running,monitoring)"},
            order="created_at.asc",
            limit=limit,
        )
        now = dt.datetime.now(dt.timezone.utc)
        runnable = []
        for row in rows:
            if row.get("status") in ("queued", "running"):
                runnable.append(row)
                continue
            next_run = row.get("next_run_at")
            if not next_run:
                runnable.append(row)
                continue
            parsed = dt.datetime.fromisoformat(next_run.replace("Z", "+00:00"))
            if parsed <= now:
                runnable.append(row)
        return runnable

    def update_job(self, job_id: str, **changes: Any) -> Dict[str, Any]:
        rows = self.rest.update(
            "crawl_jobs", changes, {"id": "eq." + str(job_id)}
        )
        return rows[0] if rows else {}

    def increment_job(self, job_id: str, **increments: int) -> Dict[str, Any]:
        job = self.get_job(job_id) or {}
        changes = {
            key: int(job.get(key) or 0) + int(value)
            for key, value in increments.items()
        }
        changes["last_heartbeat"] = utcnow()
        return self.update_job(job_id, **changes)

    def update_job_control(self, job_id: str, action: str) -> Dict[str, Any]:
        if action == "pause":
            return self.update_job(job_id, pause_requested=True)
        if action == "resume":
            return self.update_job(
                job_id,
                pause_requested=False,
                cancel_requested=False,
                status="queued",
                current_stage="queued",
                next_run_at=utcnow(),
            )
        if action == "cancel":
            return self.update_job(job_id, cancel_requested=True)
        if action == "start":
            return self.update_job(job_id, status="queued", next_run_at=utcnow())
        raise ValueError(f"Unsupported job action: {action}")

    def add_event(
        self,
        job_id: str,
        stage: str,
        message: str,
        *,
        severity: str = "info",
        details: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self.rest.insert(
            "crawl_events",
            {
                "job_id": job_id,
                "stage": stage,
                "severity": severity,
                "message": message,
                "details": dict(details or {}),
            },
        )[0]

    def list_events(
        self,
        job_id: Optional[str] = None,
        stage: Optional[str] = None,
        severity: Optional[str] = None,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        filters: Dict[str, str] = {}
        if job_id:
            filters["job_id"] = "eq." + job_id
        if stage:
            filters["stage"] = "eq." + stage
        if severity:
            filters["severity"] = "eq." + severity
        return self.rest.select(
            "crawl_events", filters=filters, order="created_at.desc", limit=limit
        )

    def upsert_item(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        return self.rest.upsert(
            "crawl_items", dict(payload), on_conflict="job_id,idempotency_key"
        )[0]

    def update_item(self, item_id: str, **changes: Any) -> Dict[str, Any]:
        rows = self.rest.update(
            "crawl_items", changes, {"id": "eq." + str(item_id)}
        )
        return rows[0] if rows else {}

    def get_item_by_key(
        self, job_id: str, idempotency_key: str
    ) -> Optional[Dict[str, Any]]:
        rows = self.rest.select(
            "crawl_items",
            filters={
                "job_id": "eq." + job_id,
                "idempotency_key": "eq." + idempotency_key,
            },
            limit=1,
        )
        return rows[0] if rows else None

    def list_items(
        self,
        job_id: str,
        *,
        status: Optional[str] = None,
        item_type: Optional[str] = None,
        limit: int = 1000,
    ) -> List[Dict[str, Any]]:
        filters = {"job_id": "eq." + job_id}
        if status:
            filters["status"] = "eq." + status
        if item_type:
            filters["item_type"] = "eq." + item_type
        return self._select_paginated(
            "crawl_items",
            filters=filters,
            order="created_at.asc,id.asc",
            limit=limit,
        )

    def retry_failed_items(self, job_id: str) -> List[Dict[str, Any]]:
        rows = self.rest.update(
            "crawl_items",
            {"status": "queued", "last_error": None},
            {"job_id": "eq." + job_id, "status": "eq.failed"},
        )
        job = self.get_job(job_id) or {}
        self.update_job(
            job_id,
            status="queued",
            current_stage="queued",
            failed_count=max(0, int(job.get("failed_count") or 0) - len(rows)),
            cancel_requested=False,
            pause_requested=False,
            next_run_at=utcnow(),
        )
        return rows

    def recover_stale_items(self, stale_minutes: int = 5) -> int:
        cutoff = (
            dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=stale_minutes)
        ).isoformat()
        rows = self.rest.update(
            "crawl_items",
            {"status": "queued", "last_error": "Recovered stale item"},
            {"status": "eq.running", "updated_at": "lt." + cutoff},
        )
        return len(rows)

    def upsert_document(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        return self.rest.upsert(
            "documents", dict(payload), on_conflict="url_hash"
        )[0]

    def get_document(self, document_id: str) -> Optional[Dict[str, Any]]:
        rows = self.rest.select(
            "documents", filters={"id": "eq." + document_id}, limit=1
        )
        return rows[0] if rows else None

    def get_document_by_hash(self, url_hash: str) -> Optional[Dict[str, Any]]:
        rows = self.rest.select(
            "documents", filters={"url_hash": "eq." + url_hash}, limit=1
        )
        return rows[0] if rows else None

    def list_documents_preview(self, limit: int = 100) -> List[Dict[str, Any]]:
        return self.rest.select(
            "documents",
            columns=(
                "id,platform,title,canonical_url,published_at,last_seen_at,"
                "fetch_status,agent_enriched,classification_status,"
                "classifications(primary_category,confidence,severity,summary),"
                "document_indicators(confidence,evidence_source,indicators(kind,display_value)),"
                "media_evidence(source_url,vision_status,visual_description,extracted_text,qr_present)"
            ),
            order="last_seen_at.desc",
            limit=limit,
        )

    def list_documents_for_reclassification(
        self,
        *,
        limit: int = 100,
        platforms: Sequence[str] = (),
        categories: Sequence[str] = (),
        classification_statuses: Sequence[str] = (),
        document_ids: Sequence[str] = (),
        published_after: Optional[str] = None,
        published_before: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Load already-fetched evidence for a classification-only batch.

        The nested comments/media are read as evidence; callers update only the
        classification and indicator tables, so this query never causes a refetch.
        """

        if limit < 1:
            raise ValueError("limit must be at least 1")

        def in_filter(values: Sequence[str]) -> str:
            cleaned = [str(value).strip() for value in values if str(value).strip()]
            if any(any(character in value for character in ",()") for value in cleaned):
                raise ValueError("PostgREST filter values cannot contain ',', '(' or ')'")
            return "in.({})".format(",".join(cleaned))

        filters: Dict[str, str] = {"fetch_status": "eq.completed"}
        if platforms:
            filters["platform"] = in_filter(platforms)
        if classification_statuses:
            filters["classification_status"] = in_filter(classification_statuses)
        if document_ids:
            filters["id"] = in_filter(document_ids)
        if published_after and published_before:
            filters["and"] = "(published_at.gte.{},published_at.lte.{})".format(
                published_after, published_before
            )
        elif published_after:
            filters["published_at"] = "gte." + published_after
        elif published_before:
            filters["published_at"] = "lte." + published_before

        classification_relation = "classifications!inner" if categories else "classifications"
        if categories:
            filters["classifications.primary_category"] = in_filter(categories)

        return self._select_paginated(
            "documents",
            columns=(
                "id,canonical_url,platform,author_display_name,title,body,language,"
                "published_at,search_title,search_snippet,fetch_status,"
                "classification_status,last_seen_at,"
                "document_comments(id,author_display_name,body,published_at),"
                "media_evidence(id,source_url,visual_description,extracted_text,"
                "qr_present,qr_payload,vision_status,vision_confidence),"
                "{}(primary_category,confidence,severity,specific_case,prompt_version)".format(
                    classification_relation
                )
            ),
            filters=filters,
            order="last_seen_at.desc,id.asc",
            limit=limit,
        )

    def set_document_classification_status(
        self, document_id: str, status: str
    ) -> Dict[str, Any]:
        rows = self.rest.update(
            "documents",
            {"classification_status": str(status)},
            {"id": "eq." + str(document_id)},
        )
        return rows[0] if rows else {}

    def upsert_discovery(
        self,
        *,
        job_id: str,
        query_item_id: Optional[str],
        document_id: str,
        search_provider: str,
        query_fingerprint: str,
        query_text: str,
        result: Mapping[str, Any],
    ) -> Dict[str, Any]:
        """Preserve every query/document provenance edge across repeated discovery."""

        row = {
            "job_id": job_id,
            "query_item_id": query_item_id,
            "document_id": document_id,
            "search_provider": search_provider,
            "query_fingerprint": query_fingerprint,
            "query_text": query_text,
            "search_position": result.get("position"),
            "result_title": result.get("title"),
            "result_snippet": result.get("snippet"),
            "result_date_text": result.get("date"),
            "raw_result": dict(result),
            "discovered_at": utcnow(),
        }
        return self.rest.upsert(
            "document_discoveries",
            row,
            on_conflict="job_id,query_fingerprint,document_id",
        )[0]

    def list_global_analysis_documents(self, limit: int = 5000) -> List[Dict[str, Any]]:
        """Load all classified documents and their indicator edges for global analysis."""

        return self._select_paginated(
            "documents",
            columns=(
                "id,canonical_url,published_at,first_seen_at,last_seen_at,"
                "classifications(primary_category,confidence,severity,specific_case,"
                "scam_types,bank_roles),"
                "document_indicators(confidence,evidence_source,evidence_quote,"
                "indicators(kind,normalized_value,display_value))"
            ),
            filters={"classification_status": "eq.completed"},
            order="last_seen_at.desc,id.asc",
            limit=limit,
        )

    def replace_live_analytics(
        self,
        job_id: Optional[str],
        analytics: Mapping[str, Any],
        *,
        prune: bool = False,
    ) -> Dict[str, int]:
        """Atomically-shaped, idempotent refresh of global metrics and graph rows.

        PostgREST calls are intentionally small and explicit for the hackathon. Old
        clusters/anomalies are retained for audit but marked inactive.
        """

        refreshed_at = utcnow()
        metrics = dict(analytics.get("metrics") or {})
        metric_rows: List[Dict[str, Any]] = []

        def add_metric(scope: str, key: str, value: Mapping[str, Any]) -> None:
            payload = dict(value)
            evidence_documents = list(payload.pop("evidence_document_ids", []) or [])
            evidence_indicators = list(payload.pop("evidence_indicator_keys", []) or [])
            metric_rows.append(
                {
                    "job_id": job_id,
                    "metric_scope": scope,
                    "metric_key": str(key),
                    "metric_value": payload,
                    "evidence_document_ids": evidence_documents,
                    "evidence_indicator_keys": evidence_indicators,
                    "refreshed_at": refreshed_at,
                }
            )

        if metrics.get("summary"):
            add_metric("summary", "global", metrics["summary"])
        for row in metrics.get("by_category") or []:
            add_metric("category", str(row.get("category") or "unknown"), row)
        for row in metrics.get("by_severity") or []:
            add_metric("severity", str(row.get("severity") or 0), row)
        for row in metrics.get("by_indicator") or []:
            add_metric("indicator", str(row.get("indicator_key") or "unknown"), row)
        if prune:
            self.rest.delete(
                "analysis_metrics",
                {"metric_scope": "in.(summary,category,severity,indicator)"},
            )
        if metric_rows:
            self.rest.upsert(
                "analysis_metrics",
                metric_rows,
                on_conflict="metric_scope,metric_key",
            )

        if prune:
            self.rest.update(
                "campaign_clusters", {"is_active": False}, {"id": "not.is.null"}
            )
        cluster_ids: Dict[str, str] = {}
        for cluster in analytics.get("clusters") or []:
            if not cluster.get("is_linked") or int(cluster.get("document_count") or 0) < 2:
                continue
            _validate_campaign_cluster(cluster)
            analytics_cluster_id = str(cluster.get("cluster_id") or "")
            cluster_key = str(cluster.get("campaign_key") or analytics_cluster_id)
            if not cluster_key:
                continue
            document_count = int(cluster.get("document_count") or 0)
            maximum_severity = int(cluster.get("maximum_severity") or 0)
            risk_score = round(maximum_severity + min(document_count, 10) * 0.2, 4)
            rows = self.rest.upsert(
                "campaign_clusters",
                {
                    "job_id": job_id,
                    "cluster_key": cluster_key,
                    "algorithm": "strong_indicator_components_v3_scam_only",
                    "is_active": True,
                    "risk_score": risk_score,
                    "document_count": document_count,
                    "indicator_count": len(cluster.get("indicator_keys") or []),
                    "maximum_severity": maximum_severity,
                    "average_confidence": float(cluster.get("average_confidence") or 0),
                    "category_counts": cluster.get("category_counts") or [],
                    "scam_types": cluster.get("scam_types") or [],
                    "bank_roles": cluster.get("bank_roles") or [],
                    "indicator_keys": cluster.get("indicator_keys") or [],
                    "shared_indicator_keys": cluster.get("shared_indicator_keys") or [],
                    "first_seen_at": cluster.get("first_seen_at"),
                    "last_seen_at": cluster.get("last_seen_at"),
                    "metrics": {
                        "is_linked": bool(cluster.get("is_linked")),
                        "anchor_indicator_key": cluster.get("anchor_indicator_key"),
                        "document_indicator_edge_count": int(
                            cluster.get("document_indicator_edge_count") or 0
                        ),
                    },
                },
                on_conflict="cluster_key",
            )
            if not rows:
                continue
            cluster_id = str(rows[0]["id"])
            cluster_ids[cluster_key] = cluster_id
            if analytics_cluster_id:
                cluster_ids[analytics_cluster_id] = cluster_id
            self.rest.delete(
                "campaign_cluster_documents", {"cluster_id": "eq." + cluster_id}
            )
            memberships = list(cluster.get("memberships") or [])
            if not memberships:
                memberships = [
                    {
                        "document_id": document_id,
                        "membership_score": 1,
                        "reasons": [],
                    }
                    for document_id in cluster.get("document_ids") or []
                ]
            members = [
                {
                    "cluster_id": cluster_id,
                    "document_id": str(membership.get("document_id")),
                    "membership_score": float(
                        membership.get("membership_score") or 0
                    ),
                    "reasons": membership.get("reasons") or [],
                }
                for membership in memberships
                if membership.get("document_id")
            ]
            if members:
                self.rest.upsert(
                    "campaign_cluster_documents",
                    members,
                    on_conflict="cluster_id,document_id",
                )

        if prune:
            self.rest.update(
                "anomalies", {"is_active": False}, {"id": "not.is.null"}
            )
        anomaly_rows: List[Dict[str, Any]] = []
        for anomaly in analytics.get("anomalies") or []:
            observed = float(anomaly.get("observed_value") or 0)
            anomaly_type = str(anomaly.get("anomaly_type") or "unknown")
            severity = min(5, max(1, int(round(observed))))
            cluster_key = anomaly.get("cluster_id")
            anomaly_rows.append(
                {
                    "job_id": job_id,
                    "cluster_id": cluster_ids.get(str(cluster_key)) if cluster_key else None,
                    "anomaly_key": str(anomaly.get("anomaly_id") or stable_hash(anomaly)),
                    "anomaly_type": anomaly_type,
                    "is_active": True,
                    "score": observed,
                    "severity": severity,
                    "reason": "{}: observed {}, threshold {}".format(
                        anomaly_type,
                        anomaly.get("observed_value"),
                        anomaly.get("threshold"),
                    ),
                    "metrics": {
                        "observed_value": anomaly.get("observed_value"),
                        "threshold": anomaly.get("threshold"),
                        "document_count": anomaly.get("document_count"),
                        "indicator_key": anomaly.get("indicator_key"),
                    },
                    "evidence_document_ids": anomaly.get("evidence_document_ids") or [],
                    "evidence_indicator_keys": anomaly.get("evidence_indicator_keys") or [],
                    "detected_at": refreshed_at,
                }
            )
        if anomaly_rows:
            self.rest.upsert("anomalies", anomaly_rows, on_conflict="anomaly_key")

        return {
            "metrics": len(metric_rows),
            "clusters": len(cluster_ids),
            "anomalies": len(anomaly_rows),
        }

    def list_analysis_metrics(self, limit: int = 500) -> List[Dict[str, Any]]:
        return self.rest.select(
            "analysis_metrics", order="refreshed_at.desc", limit=limit
        )

    def list_campaign_clusters(
        self, limit: int = 200, *, active_only: bool = True
    ) -> List[Dict[str, Any]]:
        filters = {"is_active": "eq.true"} if active_only else None
        return self.rest.select(
            "campaign_clusters",
            columns=(
                "*,campaign_cluster_documents(document_id,documents(canonical_url,title))"
            ),
            filters=filters,
            order="risk_score.desc,document_count.desc",
            limit=limit,
        )

    def list_stable_campaigns(
        self, limit: int = 200, *, active_only: bool = True
    ) -> List[Dict[str, Any]]:
        """Return the analyst-facing campaign layer for future matching APIs."""

        filters = {"is_active": "eq.true", "status": "neq.dismissed"} if active_only else None
        return self._select_paginated(
            "campaigns",
            columns=(
                "*,campaign_documents(document_id,membership_score,reasons,"
                "analyst_confirmed,is_active,documents(canonical_url,title,published_at)),"
                "campaign_indicators(role,weight,reasons,is_active,"
                "indicators(id,kind,normalized_value,display_value))"
            ),
            filters=filters,
            order="risk_score.desc,document_count.desc,id.asc",
            limit=limit,
        )

    def replace_stable_campaigns(
        self,
        job_id: Optional[str],
        analytics: Mapping[str, Any],
        *,
        prune: bool = True,
    ) -> Dict[str, int]:
        """Materialize durable campaigns from explainable derivative clusters.

        Analyst-edited labels, statuses, campaign confirmations and membership
        confirmations are deliberately omitted from update payloads. They survive
        future crawler refreshes while unconfirmed derivative rows can be marked
        inactive and replaced safely.
        """

        clusters: List[Dict[str, Any]] = []
        for raw_cluster in analytics.get("clusters") or []:
            cluster = dict(raw_cluster)
            if not cluster.get("is_linked") or int(cluster.get("document_count") or 0) < 2:
                continue
            _validate_campaign_cluster(cluster)
            clusters.append(cluster)
        existing_campaigns = self._select_paginated(
            "campaigns", order="updated_at.desc,id.asc", limit=5000
        )
        existing_by_key = {
            str(row.get("campaign_key")): dict(row)
            for row in existing_campaigns
            if row.get("campaign_key")
        }
        derivative_clusters = self._select_paginated(
            "campaign_clusters",
            columns="id,cluster_key",
            filters={"is_active": "eq.true"},
            order="id.asc",
            limit=5000,
        )
        derivative_id_by_key = {
            str(row.get("cluster_key")): str(row.get("id"))
            for row in derivative_clusters
            if row.get("cluster_key") and row.get("id")
        }
        indicator_rows = self._select_paginated(
            "indicators",
            columns="id,kind,normalized_value",
            order="id.asc",
            limit=20000,
        )
        indicator_id_by_key = {
            "{}|{}".format(row.get("kind"), row.get("normalized_value")): str(
                row.get("id")
            )
            for row in indicator_rows
            if row.get("id") and row.get("kind") and row.get("normalized_value")
        }

        claimed_existing_ids: set[str] = set()
        campaign_count = 0
        membership_count = 0
        campaign_indicator_count = 0
        missing_indicator_count = 0

        for cluster in clusters:
            desired_key = str(cluster.get("campaign_key") or cluster.get("cluster_id"))
            shared_keys = sorted(set(cluster.get("shared_indicator_keys") or []))
            existing = existing_by_key.get(desired_key)

            # If the preferred anchor changes after new evidence arrives, reuse a
            # prior campaign that overlaps on another shared indicator. This keeps
            # analyst identity stable across component growth and merges.
            if existing is None:
                candidates: List[tuple[int, int, str, Dict[str, Any]]] = []
                shared_set = set(shared_keys)
                for row in existing_campaigns:
                    row_id = str(row.get("id") or "")
                    if not row_id or row_id in claimed_existing_ids:
                        continue
                    metadata = dict(row.get("metadata") or {})
                    previous_keys = set(metadata.get("shared_indicator_keys") or [])
                    previous_keys.add(str(row.get("anchor_indicator_key") or ""))
                    overlap = len(shared_set.intersection(previous_keys))
                    if not overlap or str(row.get("status") or "") == "dismissed":
                        continue
                    candidates.append(
                        (
                            1 if row.get("analyst_confirmed") else 0,
                            overlap,
                            str(row.get("updated_at") or ""),
                            dict(row),
                        )
                    )
                if candidates:
                    candidates.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
                    existing = candidates[0][3]

            stable_key = str((existing or {}).get("campaign_key") or desired_key)
            anchor_key = str(
                (existing or {}).get("anchor_indicator_key")
                or cluster.get("anchor_indicator_key")
            )
            existing_status = str((existing or {}).get("status") or "provisional")
            metadata = dict((existing or {}).get("metadata") or {})
            generate_label = not str((existing or {}).get("label") or "").strip()
            metadata.update(
                {
                    "source_algorithm": "strong_indicator_components_v3_scam_only",
                    "source_cluster_key": desired_key,
                    "anchor_indicator_key": cluster.get("anchor_indicator_key"),
                    "shared_indicator_keys": shared_keys,
                    "category_counts": cluster.get("category_counts") or [],
                }
            )
            if generate_label:
                metadata["label_source"] = "generated"
            campaign_payload: Dict[str, Any] = {
                "campaign_key": stable_key,
                "anchor_indicator_key": anchor_key,
                "source_cluster_id": derivative_id_by_key.get(desired_key),
                "is_active": existing_status != "dismissed",
                "risk_score": round(
                    int(cluster.get("maximum_severity") or 0)
                    + min(int(cluster.get("document_count") or 0), 10) * 0.2,
                    4,
                ),
                "document_count": int(cluster.get("document_count") or 0),
                "indicator_count": len(cluster.get("indicator_keys") or []),
                "maximum_severity": int(cluster.get("maximum_severity") or 0),
                "average_confidence": float(cluster.get("average_confidence") or 0),
                "scam_types": cluster.get("scam_types") or [],
                "bank_roles": cluster.get("bank_roles") or [],
                "shared_indicator_keys": shared_keys,
                "first_seen_at": cluster.get("first_seen_at"),
                "last_seen_at": cluster.get("last_seen_at"),
                "metadata": metadata,
            }
            if generate_label:
                campaign_payload["label"] = _campaign_label(
                    anchor_key, cluster.get("scam_types") or []
                )
            rows = self.rest.upsert(
                "campaigns", campaign_payload, on_conflict="campaign_key"
            )
            if not rows:
                continue
            campaign = dict(rows[0])
            campaign_id = str(campaign["id"])
            claimed_existing_ids.add(campaign_id)
            campaign_count += 1
            member_active = str(campaign.get("status") or existing_status) != "dismissed"

            # Refresh one campaign at a time. Existing campaigns remain live
            # until their replacement is ready, so an interrupted global run
            # cannot blank or partially repopulate the served registry.
            if prune:
                self.rest.update(
                    "campaign_documents",
                    {"is_active": False},
                    {
                        "campaign_id": "eq." + campaign_id,
                        "analyst_confirmed": "eq.false",
                    },
                )
                self.rest.update(
                    "campaign_indicators",
                    {"is_active": False},
                    {"campaign_id": "eq." + campaign_id, "is_active": "eq.true"},
                )

            memberships = list(cluster.get("memberships") or [])
            if memberships:
                member_rows = [
                    {
                        "campaign_id": campaign_id,
                        "document_id": str(item.get("document_id")),
                        "membership_score": float(item.get("membership_score") or 0),
                        "reasons": item.get("reasons") or [],
                        "is_active": member_active,
                    }
                    for item in memberships
                    if item.get("document_id")
                ]
                if member_rows:
                    self.rest.upsert(
                        "campaign_documents",
                        member_rows,
                        on_conflict="campaign_id,document_id",
                    )
                    membership_count += len(member_rows)

            reason_by_key: Dict[str, List[Dict[str, Any]]] = {}
            for membership in memberships:
                for reason in membership.get("reasons") or []:
                    key = str(reason.get("indicator_key") or "")
                    if key and reason not in reason_by_key.setdefault(key, []):
                        reason_by_key[key].append(dict(reason))
            campaign_indicator_rows: List[Dict[str, Any]] = []
            materialized_indicator_keys = list(shared_keys)
            if anchor_key not in materialized_indicator_keys:
                materialized_indicator_keys.append(anchor_key)
            for key in materialized_indicator_keys:
                indicator_id = indicator_id_by_key.get(key)
                if not indicator_id:
                    missing_indicator_count += 1
                    continue
                reasons = reason_by_key.get(key) or []
                weight = max(
                    (float(reason.get("strength") or 0) for reason in reasons),
                    default=1.0 if key == anchor_key else 0.5,
                )
                campaign_indicator_rows.append(
                    {
                        "campaign_id": campaign_id,
                        "indicator_id": indicator_id,
                        "role": "anchor" if key == anchor_key else "shared",
                        "weight": min(1.0, max(0.0, weight)),
                        "reasons": reasons,
                        "is_active": member_active,
                    }
                )
            if campaign_indicator_rows:
                self.rest.upsert(
                    "campaign_indicators",
                    campaign_indicator_rows,
                    on_conflict="campaign_id,indicator_id",
                )
                campaign_indicator_count += len(campaign_indicator_rows)

        if prune:
            for row in existing_campaigns:
                campaign_id = str(row.get("id") or "")
                if (
                    not campaign_id
                    or campaign_id in claimed_existing_ids
                    or row.get("analyst_confirmed") is True
                ):
                    continue
                self.rest.update(
                    "campaign_documents",
                    {"is_active": False},
                    {
                        "campaign_id": "eq." + campaign_id,
                        "analyst_confirmed": "eq.false",
                    },
                )
                self.rest.update(
                    "campaign_indicators",
                    {"is_active": False},
                    {"campaign_id": "eq." + campaign_id, "is_active": "eq.true"},
                )
                self.rest.update(
                    "campaigns",
                    {"is_active": False},
                    {
                        "id": "eq." + campaign_id,
                        "analyst_confirmed": "eq.false",
                    },
                )

        return {
            "campaigns": campaign_count,
            "campaign_documents": membership_count,
            "campaign_indicators": campaign_indicator_count,
            "missing_indicators": missing_indicator_count,
        }

    def list_anomalies(
        self, limit: int = 200, *, active_only: bool = True
    ) -> List[Dict[str, Any]]:
        filters = {"is_active": "eq.true"} if active_only else None
        return self.rest.select(
            "anomalies", filters=filters, order="score.desc,detected_at.desc", limit=limit
        )

    def upsert_grounded_insights(
        self,
        *,
        job_id: Optional[str],
        summary: Mapping[str, Any],
        model: str,
        prompt_version: str,
        document_urls: Mapping[str, str],
    ) -> int:
        rows: List[Dict[str, Any]] = []
        for item in summary.get("insights") or []:
            requested_ids = [str(value) for value in item.get("evidence_document_ids") or []]
            evidence_ids = [value for value in requested_ids if value in document_urls]
            evidence_links = [document_urls[value] for value in evidence_ids]
            key = stable_hash(
                {
                    "title": item.get("title"),
                    "evidence_document_ids": evidence_ids,
                }
            )
            rows.append(
                {
                    "job_id": job_id,
                    "insight_key": key,
                    "insight_type": "campaign_summary",
                    "title": str(item.get("title") or "Scam insight"),
                    "summary": str(item.get("summary") or ""),
                    "severity": min(5, max(1, int(item.get("severity") or 1))),
                    "confidence": min(1, max(0, float(item.get("confidence") or 0))),
                    "model": model,
                    "prompt_version": prompt_version,
                    "metrics": {"overview": summary.get("overview") or ""},
                    "evidence_document_ids": evidence_ids,
                    "evidence_links": evidence_links,
                    "raw_output": dict(item),
                }
            )
        self.rest.delete("grounded_insights", {"id": "not.is.null"})
        if rows:
            self.rest.upsert("grounded_insights", rows, on_conflict="insight_key")
        return len(rows)

    def list_grounded_insights(self, limit: int = 100) -> List[Dict[str, Any]]:
        return self.rest.select(
            "grounded_insights", order="updated_at.desc", limit=limit
        )

    def replace_comments(
        self, document_id: str, comments: Sequence[Mapping[str, Any]]
    ) -> None:
        if not comments:
            return
        rows = []
        for index, comment in enumerate(comments):
            body = str(comment.get("text") or comment.get("body") or "").strip()
            if not body:
                continue
            rows.append(
                {
                    "document_id": document_id,
                    "external_comment_id": str(
                        comment.get("id")
                        or comment.get("external_id")
                        or "agent-{}-{}".format(
                            index, hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
                        )
                    ),
                    "author_display_name": comment.get("author_display_name"),
                    "body": body,
                    "published_at_text": comment.get("published_at"),
                    "raw_metadata": dict(comment),
                }
            )
        if rows:
            self.rest.upsert(
                "document_comments",
                rows,
                on_conflict="document_id,external_comment_id",
            )

    def replace_media(
        self,
        document_id: str,
        media: Sequence[Mapping[str, Any]],
        agent_run_id: Optional[str],
    ) -> None:
        if not media:
            return
        rows = []
        for index, item in enumerate(media):
            source_url = item.get("source_url") or item.get("image_url")
            media_key = str(source_url or f"agent-media-{index}")
            rows.append(
                {
                    "document_id": document_id,
                    "media_key": media_key,
                    "media_type": item.get("type") or item.get("media_type") or "image",
                    "source_url": source_url,
                    "visual_description": item.get("visual_evidence")
                    or item.get("visual_description")
                    or item.get("description"),
                    "media_hash": item.get("media_hash") or item.get("content_hash"),
                    "qr_present": bool(item.get("qr_present")),
                    "qr_payload": item.get("qr_payload"),
                    "qr_confidence": item.get("qr_confidence"),
                    "qr_confidence_text": None,
                    "agent_run_id": agent_run_id,
                    "extracted_text": item.get("visible_text")
                    or item.get("extracted_text"),
                    "vision_status": item.get("vision_status")
                    or (
                        "completed"
                        if item.get("visual_description") or item.get("description")
                        else "pending"
                    ),
                    "vision_provider": item.get("vision_provider"),
                    "vision_model": item.get("vision_model"),
                    "vision_confidence": item.get("vision_confidence")
                    if item.get("vision_confidence") is not None
                    else item.get("confidence"),
                    "analyzed_at": item.get("analyzed_at"),
                    "raw_metadata": dict(item),
                }
            )
        self.rest.upsert(
            "media_evidence", rows, on_conflict="document_id,media_key"
        )

    def upsert_classification(
        self,
        document_id: str,
        classification: Mapping[str, Any],
        *,
        job_id: Optional[str] = None,
        provider: str = "openai",
        model: str,
        prompt_version: str,
    ) -> Dict[str, Any]:
        row = {
            "document_id": document_id,
            "job_id": job_id,
            "provider": provider,
            "model": model,
            "prompt_version": prompt_version,
            "primary_category": classification.get("primary_category", "noise"),
            "scam_types": classification.get("scam_types") or [],
            "bank_roles": classification.get("bank_roles") or [],
            "specific_case": bool(classification.get("specific_case")),
            "first_person_report": bool(
                classification.get("first_person_report")
            ),
            "summary": classification.get("summary") or "",
            "severity": int(classification.get("severity") or 0),
            "confidence": float(classification.get("confidence") or 0),
            "evidence": classification.get("evidence") or [],
            "raw_output": dict(classification),
        }
        return self.rest.upsert(
            "classifications", row, on_conflict="document_id"
        )[0]

    def upsert_indicators(
        self,
        document_id: str,
        indicators: Sequence[Mapping[str, Any]],
    ) -> int:
        # A reclassification replaces evidence edges so obsolete AI-extracted
        # identifiers cannot keep linking campaigns.
        self.rest.delete(
            "document_indicators", {"document_id": "eq." + document_id}
        )
        count = 0
        for item in indicators:
            kind = str(item.get("type") or item.get("kind") or "").strip()
            normalized = str(item.get("normalized_value") or "").strip()
            display = str(item.get("value") or item.get("display_value") or "").strip()
            if not kind or not normalized:
                continue
            indicator = self.rest.upsert(
                "indicators",
                {
                    "kind": kind,
                    "normalized_value": normalized,
                    "display_value": display or normalized,
                },
                on_conflict="kind,normalized_value",
            )[0]
            self.rest.upsert(
                "document_indicators",
                {
                    "document_id": document_id,
                    "indicator_id": indicator["id"],
                    "confidence": float(item.get("confidence") or 0.8),
                    "evidence_source": item.get("evidence_source") or "ai",
                    "evidence_quote": item.get("evidence_quote"),
                },
                on_conflict="document_id,indicator_id,evidence_source",
            )
            count += 1
        return count

    def add_usage(
        self,
        job_id: str,
        provider: str,
        operation: str,
        *,
        document_id: Optional[str] = None,
        request_id: Optional[str] = None,
        model: Optional[str] = None,
        status: str = "completed",
        units: float = 1,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        total_tokens: Optional[int] = None,
        duration_ms: Optional[int] = None,
        details: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self.rest.insert(
            "provider_usage",
            {
                "job_id": job_id,
                "document_id": document_id,
                "provider": provider,
                "operation": operation,
                "request_id": request_id,
                "model": model,
                "status": status,
                "units": units,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
                "duration_ms": duration_ms,
                "details": dict(details or {}),
            },
        )[0]

    def list_provider_usage(
        self, job_id: Optional[str] = None, limit: int = 1000
    ) -> List[Dict[str, Any]]:
        filters = {"job_id": "eq." + job_id} if job_id else None
        return self.rest.select(
            "provider_usage",
            filters=filters,
            order="created_at.desc",
            limit=limit,
        )
