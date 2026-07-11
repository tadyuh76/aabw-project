"""Deterministic, dependency-free analytics for classified scam documents.

The crawler persists graph-ready evidence, while this module turns a batch of
classified documents into three JSON/SQL-friendly outputs:

* aggregate category, severity, and indicator metric rows;
* connected document clusters linked by normalized indicators; and
* evidence-backed anomaly flags for high severity, repeated indicators, and
  large connected components (``burst_size``).

The current input contract does not include a timestamp, so ``burst_size`` is
deliberately a graph-size signal rather than a temporal velocity signal.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, DefaultDict, Dict, Iterable, List, Mapping, Sequence, Tuple

from .normalization import (
    VALID_CATEGORIES,
    collapse_whitespace,
    normalize_indicator,
    normalize_indicator_type,
    stable_hash,
)


DEFAULT_HIGH_SEVERITY_THRESHOLD = 4
DEFAULT_REPEATED_INDICATOR_THRESHOLD = 2
DEFAULT_BURST_SIZE_THRESHOLD = 3
CAMPAIGN_ELIGIBLE_CATEGORIES = frozenset({"scam_report", "impersonation_abuse"})
CAMPAIGN_MINIMUM_CONFIDENCE = 0.6

# Only identifiers that plausibly persist across multiple posts are allowed to
# create campaign edges. Contextual values such as a URL, person name, payment
# method, or amount remain useful metrics but are too noisy for clustering.
STRONG_CLUSTER_INDICATOR_TYPES = frozenset(
    {
        "bank_account",
        "phone",
        "email",
        "domain",
        "social_account",
        "qr_payload",
        "transaction_reference",
        "media_hash",
        "message_template",
    }
)


def _bounded_float(value: Any, lower: float, upper: float, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return max(lower, min(upper, number))


def _bounded_int(value: Any, lower: int, upper: int, default: int) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        number = default
    return max(lower, min(upper, number))


def _average(values: Iterable[float]) -> float:
    numbers = list(values)
    if not numbers:
        return 0.0
    return round(sum(numbers) / len(numbers), 6)


def _indicator_key(kind: str, normalized_value: str) -> str:
    """Return a stable, human-readable graph key for an indicator."""

    return "{}|{}".format(kind, normalized_value)


def _normalize_document(document: Mapping[str, Any]) -> Dict[str, Any]:
    document_id = collapse_whitespace(document.get("document_id") or document.get("id"))
    if not document_id:
        raise ValueError("Every analytics input row requires document_id")

    category = normalize_indicator_type(
        document.get("category") or document.get("primary_category")
    )
    if category not in VALID_CATEGORIES:
        category = "noise"

    indicators_by_key: Dict[str, Dict[str, Any]] = {}
    raw_indicators = document.get("indicators") or []
    if not isinstance(raw_indicators, Sequence) or isinstance(raw_indicators, (str, bytes)):
        raw_indicators = []
    for raw_indicator in raw_indicators:
        if not isinstance(raw_indicator, Mapping):
            continue
        candidate = dict(raw_indicator)
        candidate["type"] = candidate.get("type") or candidate.get("kind")
        candidate["value"] = (
            candidate.get("value")
            or candidate.get("display_value")
            or candidate.get("normalized_value")
        )
        normalized = normalize_indicator(candidate)
        if not normalized:
            continue
        key = _indicator_key(normalized["type"], normalized["normalized_value"])
        previous = indicators_by_key.get(key)
        if previous is None or normalized["confidence"] > previous["confidence"]:
            indicators_by_key[key] = normalized

    def normalized_labels(value: Any) -> List[str]:
        values = [value] if isinstance(value, str) else value or []
        if not isinstance(values, Iterable):
            return []
        return sorted(
            {
                normalize_indicator_type(item)
                for item in values
                if normalize_indicator_type(item)
            }
        )

    confidence = _bounded_float(document.get("confidence"), 0.0, 1.0, 0.0)
    return {
        "document_id": document_id,
        "category": category,
        "confidence": confidence,
        "severity": _bounded_int(document.get("severity"), 0, 5, 0),
        "scam_types": normalized_labels(document.get("scam_types")),
        "bank_roles": normalized_labels(document.get("bank_roles")),
        "indicators": [indicators_by_key[key] for key in sorted(indicators_by_key)],
        "indicator_keys": sorted(indicators_by_key),
        "cluster_indicator_keys": sorted(
            key
            for key, indicator in indicators_by_key.items()
            if indicator["type"] in STRONG_CLUSTER_INDICATOR_TYPES
        ),
        "is_campaign_eligible": (
            category in CAMPAIGN_ELIGIBLE_CATEGORIES
            and confidence >= CAMPAIGN_MINIMUM_CONFIDENCE
        ),
    }


def _prepare_documents(documents: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    prepared = [_normalize_document(document) for document in documents]
    prepared.sort(key=lambda document: document["document_id"])
    document_ids = [document["document_id"] for document in prepared]
    if len(document_ids) != len(set(document_ids)):
        duplicates = sorted(
            document_id
            for document_id, count in Counter(document_ids).items()
            if count > 1
        )
        raise ValueError("Duplicate document_id values: {}".format(", ".join(duplicates)))
    return prepared


def _build_metrics(prepared: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    total_documents = len(prepared)
    edge_count = sum(len(document["indicator_keys"]) for document in prepared)
    all_indicator_keys = sorted(
        {
            key
            for document in prepared
            for key in document["indicator_keys"]
        }
    )

    category_rows: List[Dict[str, Any]] = []
    by_category: DefaultDict[str, List[Mapping[str, Any]]] = defaultdict(list)
    for document in prepared:
        by_category[document["category"]].append(document)
    for category in sorted(by_category):
        evidence = by_category[category]
        category_rows.append(
            {
                "category": category,
                "document_count": len(evidence),
                "document_share": round(len(evidence) / total_documents, 6)
                if total_documents
                else 0.0,
                "average_confidence": _average(
                    document["confidence"] for document in evidence
                ),
                "maximum_severity": max(document["severity"] for document in evidence),
                "evidence_document_ids": sorted(
                    document["document_id"] for document in evidence
                ),
                "evidence_indicator_keys": sorted(
                    {
                        key
                        for document in evidence
                        for key in document["indicator_keys"]
                    }
                ),
            }
        )

    severity_rows: List[Dict[str, Any]] = []
    by_severity: DefaultDict[int, List[Mapping[str, Any]]] = defaultdict(list)
    for document in prepared:
        by_severity[document["severity"]].append(document)
    for severity in sorted(by_severity):
        evidence = by_severity[severity]
        severity_rows.append(
            {
                "severity": severity,
                "document_count": len(evidence),
                "document_share": round(len(evidence) / total_documents, 6)
                if total_documents
                else 0.0,
                "average_confidence": _average(
                    document["confidence"] for document in evidence
                ),
                "evidence_document_ids": sorted(
                    document["document_id"] for document in evidence
                ),
                "evidence_indicator_keys": sorted(
                    {
                        key
                        for document in evidence
                        for key in document["indicator_keys"]
                    }
                ),
            }
        )

    indicator_evidence: DefaultDict[str, List[Mapping[str, Any]]] = defaultdict(list)
    indicator_details: Dict[str, Mapping[str, Any]] = {}
    for document in prepared:
        indicators = {
            _indicator_key(indicator["type"], indicator["normalized_value"]): indicator
            for indicator in document["indicators"]
        }
        for key, indicator in indicators.items():
            indicator_evidence[key].append(document)
            indicator_details[key] = indicator

    indicator_rows: List[Dict[str, Any]] = []
    for key in sorted(indicator_evidence):
        evidence = indicator_evidence[key]
        detail = indicator_details[key]
        indicator_rows.append(
            {
                "indicator_key": key,
                "indicator_type": detail["type"],
                "normalized_value": detail["normalized_value"],
                "display_value": detail["value"],
                "document_count": len(evidence),
                "category_count": len({document["category"] for document in evidence}),
                "average_document_confidence": _average(
                    document["confidence"] for document in evidence
                ),
                "maximum_document_severity": max(
                    document["severity"] for document in evidence
                ),
                "evidence_document_ids": sorted(
                    document["document_id"] for document in evidence
                ),
                "evidence_indicator_keys": [key],
            }
        )

    return {
        "summary": {
            "document_count": total_documents,
            "unique_indicator_count": len(all_indicator_keys),
            "document_indicator_edge_count": edge_count,
            "average_confidence": _average(
                document["confidence"] for document in prepared
            ),
            "maximum_severity": max(
                (document["severity"] for document in prepared), default=0
            ),
            "evidence_document_ids": [
                document["document_id"] for document in prepared
            ],
            "evidence_indicator_keys": all_indicator_keys,
        },
        "by_category": category_rows,
        "by_severity": severity_rows,
        "by_indicator": indicator_rows,
    }


class _UnionFind:
    def __init__(self, keys: Iterable[str]) -> None:
        self.parent = {key: key for key in keys}

    def find(self, key: str) -> str:
        while self.parent[key] != key:
            self.parent[key] = self.parent[self.parent[key]]
            key = self.parent[key]
        return key

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        # Lexical root choice makes the component construction independent of
        # traversal order and therefore deterministic across repeated runs.
        root, child = sorted((left_root, right_root))
        self.parent[child] = root


def _cluster_documents(prepared: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    # Metrics use every classified document, but automatic campaign inference
    # deliberately excludes non-scam and low-confidence classifications.
    by_id = {
        document["document_id"]: document
        for document in prepared
        if document["is_campaign_eligible"]
    }
    union_find = _UnionFind(by_id)
    documents_by_indicator: DefaultDict[str, List[str]] = defaultdict(list)
    for document in prepared:
        if not document["is_campaign_eligible"]:
            continue
        for key in document["cluster_indicator_keys"]:
            documents_by_indicator[key].append(document["document_id"])

    for document_ids in documents_by_indicator.values():
        ordered_ids = sorted(document_ids)
        for document_id in ordered_ids[1:]:
            union_find.union(ordered_ids[0], document_id)

    components: DefaultDict[str, List[str]] = defaultdict(list)
    for document_id in sorted(by_id):
        components[union_find.find(document_id)].append(document_id)

    clusters: List[Dict[str, Any]] = []
    for document_ids in components.values():
        document_ids = sorted(document_ids)
        # A singleton is not a campaign inference. Returning only linked
        # components makes every cluster row safe to present as a relationship.
        if len(document_ids) < 2:
            continue
        members = [by_id[document_id] for document_id in document_ids]
        key_counts = Counter(
            key for document in members for key in document["cluster_indicator_keys"]
        )
        indicator_keys = sorted(key_counts)
        shared_indicator_keys = sorted(
            key for key, count in key_counts.items() if count > 1
        )
        category_counts = Counter(document["category"] for document in members)
        clusters.append(
            {
                "cluster_id": "cluster_{}".format(
                    stable_hash({"document_ids": document_ids})[:16]
                ),
                "document_count": len(document_ids),
                "document_indicator_edge_count": sum(key_counts.values()),
                "is_linked": len(document_ids) > 1,
                "maximum_severity": max(
                    (document["severity"] for document in members), default=0
                ),
                "average_confidence": _average(
                    document["confidence"] for document in members
                ),
                "category_counts": [
                    {"category": category, "document_count": category_counts[category]}
                    for category in sorted(category_counts)
                ],
                "scam_types": sorted(
                    {
                        scam_type
                        for document in members
                        for scam_type in document["scam_types"]
                    }
                ),
                "bank_roles": sorted(
                    {
                        bank_role
                        for document in members
                        for bank_role in document["bank_roles"]
                    }
                ),
                "document_ids": document_ids,
                "indicator_keys": indicator_keys,
                "shared_indicator_keys": shared_indicator_keys,
                "evidence_document_ids": document_ids,
                "evidence_indicator_keys": shared_indicator_keys,
            }
        )

    clusters.sort(key=lambda cluster: (-cluster["document_count"], cluster["document_ids"]))
    return clusters


def _validate_thresholds(
    high_severity_threshold: int,
    repeated_indicator_threshold: int,
    burst_size_threshold: int,
) -> None:
    if not 0 <= high_severity_threshold <= 5:
        raise ValueError("high_severity_threshold must be between 0 and 5")
    if repeated_indicator_threshold < 2:
        raise ValueError("repeated_indicator_threshold must be at least 2")
    if burst_size_threshold < 2:
        raise ValueError("burst_size_threshold must be at least 2")


def _detect_anomalies(
    prepared: Sequence[Mapping[str, Any]],
    clusters: Sequence[Mapping[str, Any]],
    high_severity_threshold: int,
    repeated_indicator_threshold: int,
    burst_size_threshold: int,
) -> List[Dict[str, Any]]:
    _validate_thresholds(
        high_severity_threshold,
        repeated_indicator_threshold,
        burst_size_threshold,
    )
    anomalies: List[Dict[str, Any]] = []

    for document in prepared:
        if document["severity"] < high_severity_threshold:
            continue
        document_id = document["document_id"]
        anomalies.append(
            {
                "anomaly_id": "high_severity_{}".format(stable_hash(document_id)[:16]),
                "anomaly_type": "high_severity",
                "observed_value": document["severity"],
                "threshold": high_severity_threshold,
                "document_count": 1,
                "cluster_id": None,
                "indicator_key": None,
                "evidence_document_ids": [document_id],
                "evidence_indicator_keys": list(document["indicator_keys"]),
            }
        )

    eligible_indicator_evidence: DefaultDict[str, List[str]] = defaultdict(list)
    for document in prepared:
        if not document["is_campaign_eligible"]:
            continue
        for key in document["cluster_indicator_keys"]:
            eligible_indicator_evidence[key].append(document["document_id"])

    for key in sorted(eligible_indicator_evidence):
        evidence_document_ids = sorted(set(eligible_indicator_evidence[key]))
        if len(evidence_document_ids) < repeated_indicator_threshold:
            continue
        anomalies.append(
            {
                "anomaly_id": "repeated_indicator_{}".format(stable_hash(key)[:16]),
                "anomaly_type": "repeated_indicator",
                "observed_value": len(evidence_document_ids),
                "threshold": repeated_indicator_threshold,
                "document_count": len(evidence_document_ids),
                "cluster_id": None,
                "indicator_key": key,
                "evidence_document_ids": evidence_document_ids,
                "evidence_indicator_keys": [key],
            }
        )

    for cluster in clusters:
        if cluster["document_count"] < burst_size_threshold:
            continue
        anomalies.append(
            {
                "anomaly_id": "burst_size_{}".format(cluster["cluster_id"]),
                "anomaly_type": "burst_size",
                "observed_value": cluster["document_count"],
                "threshold": burst_size_threshold,
                "document_count": cluster["document_count"],
                "cluster_id": cluster["cluster_id"],
                "indicator_key": None,
                "evidence_document_ids": list(cluster["document_ids"]),
                "evidence_indicator_keys": list(cluster["shared_indicator_keys"]),
            }
        )

    type_order = {"high_severity": 0, "repeated_indicator": 1, "burst_size": 2}
    anomalies.sort(
        key=lambda anomaly: (
            type_order[anomaly["anomaly_type"]],
            anomaly["evidence_document_ids"],
            anomaly["evidence_indicator_keys"],
            anomaly["anomaly_id"],
        )
    )
    return anomalies


def build_metrics(documents: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    """Build deterministic aggregate metric rows from classified documents."""

    return _build_metrics(_prepare_documents(documents))


def cluster_documents(documents: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """Return connected components formed by shared normalized indicators."""

    return _cluster_documents(_prepare_documents(documents))


def detect_anomalies(
    documents: Sequence[Mapping[str, Any]],
    high_severity_threshold: int = DEFAULT_HIGH_SEVERITY_THRESHOLD,
    repeated_indicator_threshold: int = DEFAULT_REPEATED_INDICATOR_THRESHOLD,
    burst_size_threshold: int = DEFAULT_BURST_SIZE_THRESHOLD,
) -> List[Dict[str, Any]]:
    """Return evidence-backed anomaly rows using configurable thresholds."""

    prepared = _prepare_documents(documents)
    clusters = _cluster_documents(prepared)
    return _detect_anomalies(
        prepared,
        clusters,
        high_severity_threshold,
        repeated_indicator_threshold,
        burst_size_threshold,
    )


def analyze_documents(
    documents: Sequence[Mapping[str, Any]],
    high_severity_threshold: int = DEFAULT_HIGH_SEVERITY_THRESHOLD,
    repeated_indicator_threshold: int = DEFAULT_REPEATED_INDICATOR_THRESHOLD,
    burst_size_threshold: int = DEFAULT_BURST_SIZE_THRESHOLD,
) -> Dict[str, Any]:
    """Build all deterministic analytics outputs in one normalization pass."""

    _validate_thresholds(
        high_severity_threshold,
        repeated_indicator_threshold,
        burst_size_threshold,
    )
    prepared = _prepare_documents(documents)
    metrics = _build_metrics(prepared)
    clusters = _cluster_documents(prepared)
    anomalies = _detect_anomalies(
        prepared,
        clusters,
        high_severity_threshold,
        repeated_indicator_threshold,
        burst_size_threshold,
    )
    return {
        "parameters": {
            "high_severity_threshold": high_severity_threshold,
            "repeated_indicator_threshold": repeated_indicator_threshold,
            "burst_size_threshold": burst_size_threshold,
        },
        "metrics": metrics,
        "clusters": clusters,
        "anomalies": anomalies,
    }


# A concise alias for callers that prefer the name used by the data module.
build_analytics = analyze_documents


__all__ = [
    "DEFAULT_BURST_SIZE_THRESHOLD",
    "DEFAULT_HIGH_SEVERITY_THRESHOLD",
    "DEFAULT_REPEATED_INDICATOR_THRESHOLD",
    "CAMPAIGN_ELIGIBLE_CATEGORIES",
    "CAMPAIGN_MINIMUM_CONFIDENCE",
    "STRONG_CLUSTER_INDICATOR_TYPES",
    "analyze_documents",
    "build_analytics",
    "build_metrics",
    "cluster_documents",
    "detect_anomalies",
]
