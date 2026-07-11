"""End-to-end ScamDNA acquisition, analysis, and live graph refresh."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import time
from dataclasses import replace
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .config import DEFAULT_DOMAINS, DEFAULT_INTENTS, Settings
from .db import SupabaseRepository, utcnow
from .pipeline import (
    OpenAIAnalysisClient,
    SearchTask,
    SerpAPIClient,
    SerpAPIError,
    TinyFishClient,
    analyze_documents,
    build_backfill_tasks,
    build_continuous_tasks,
    canonical_url_hash,
    canonicalize_url,
    infer_platform,
    split_saturated_task,
    stable_hash,
)

logger = logging.getLogger(__name__)


class JobPaused(RuntimeError):
    pass


class JobCancelled(RuntimeError):
    pass


def _list(value: Any, default: Sequence[str]) -> List[str]:
    if value is None:
        return list(default)
    if isinstance(value, str):
        value = value.replace(",", "\n").splitlines()
    return list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))


def _iso_timestamp(value: Any) -> Optional[str]:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    candidate = text.replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(candidate)
    except ValueError:
        try:
            parsed_date = dt.date.fromisoformat(candidate[:10])
        except ValueError:
            return None
        parsed = dt.datetime.combine(parsed_date, dt.time.min, tzinfo=dt.timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.isoformat()


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def _chunks(values: Sequence[Mapping[str, Any]], size: int) -> Iterable[Sequence[Mapping[str, Any]]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def _embedded_one(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return next((item for item in value if isinstance(item, Mapping)), {})
    return {}


class CrawlPipeline:
    """Provider orchestration with bounded concurrency and resumable checkpoints."""

    def __init__(
        self,
        settings: Settings,
        repository: SupabaseRepository,
        *,
        tinyfish_factory: Any = TinyFishClient,
        serpapi_factory: Any = SerpAPIClient,
        openai_factory: Any = OpenAIAnalysisClient,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.tinyfish_factory = tinyfish_factory
        self.serpapi_factory = serpapi_factory
        self.openai_factory = openai_factory
        self._max_pages = 1

    def run_job(self, job: Mapping[str, Any]) -> None:
        asyncio.run(self.run_job_async(dict(job)))

    async def run_job_async(self, job: Dict[str, Any]) -> None:
        job_id = str(job["id"])
        parameters = dict(job.get("parameters") or {})
        started = time.monotonic()
        self.repository.update_job(
            job_id,
            status="running",
            current_stage="discovering",
            started_at=job.get("started_at") or utcnow(),
            finished_at=None,
            last_heartbeat=utcnow(),
            last_error=None,
        )
        self.repository.add_event(job_id, "discovering", "Crawl cycle started")

        try:
            tasks, cycle_key = self._build_tasks(job, parameters)
            async with self.serpapi_factory(
                self.settings.serpapi_api_key
            ) as discovery, self.tinyfish_factory(
                self.settings.tinyfish_api_key
            ) as tinyfish, self.openai_factory(
                self.settings.openai_api_key,
                model=self.settings.openai_model,
                reasoning_effort=self.settings.openai_reasoning_effort,
                max_image_urls=max(0, min(2, int(parameters.get("max_vision_images") or 2))),
            ) as analyzer:
                await self._discover(
                    job_id, tasks, cycle_key, parameters, discovery, tinyfish
                )
                await self._process_documents(job_id, parameters, tinyfish, analyzer)
                await self._refresh_live_analytics(job_id)
                await self._generate_grounded_insights(job_id, parameters, analyzer)
            await self._finish_cycle(job_id, job, parameters, started)
        except JobPaused:
            self.repository.update_job(job_id, status="paused", last_heartbeat=utcnow())
            self.repository.add_event(job_id, "control", "Job paused")
        except JobCancelled:
            self.repository.update_job(
                job_id,
                status="cancelled",
                current_stage="cancelled",
                finished_at=utcnow(),
                last_heartbeat=utcnow(),
            )
            self.repository.add_event(job_id, "control", "Job cancelled", severity="warning")
        except Exception as exc:
            logger.exception("Crawl job %s failed", job_id)
            self.repository.update_job(
                job_id,
                status="failed",
                current_stage="failed",
                last_error=str(exc)[:2000],
                finished_at=utcnow(),
                last_heartbeat=utcnow(),
            )
            self.repository.add_event(
                job_id,
                "worker",
                "Crawl cycle failed",
                severity="error",
                details={"error": str(exc)},
            )
            raise

    def _build_tasks(
        self, job: Mapping[str, Any], parameters: Mapping[str, Any]
    ) -> Tuple[List[SearchTask], str]:
        keywords = _list(parameters.get("keywords"), ())
        if not keywords:
            raise ValueError("At least one keyword is required")
        domains = _list(parameters.get("target_domains"), DEFAULT_DOMAINS)
        intents = _list(parameters.get("scam_intents"), DEFAULT_INTENTS)
        self._max_pages = max(1, min(11, int(parameters.get("max_search_pages") or 1)))
        common = {
            "keywords": keywords,
            "domains": domains,
            "intents": intents,
            "max_pages": 1,
            "location": parameters.get("location") or "VN",
            "language": parameters.get("language") or "vi",
        }
        if str(job.get("mode")) == "continuous":
            interval = max(5, int(parameters.get("monitor_interval_minutes") or 15))
            tasks = build_continuous_tasks(
                interval_minutes=interval,
                overlap_minutes=min(5, interval - 1),
                **common,
            )
            bucket = int(dt.datetime.now(dt.timezone.utc).timestamp() // (interval * 60))
            cycle_key = "monitor-{}".format(bucket)
        else:
            date_from = parameters.get("date_from") or (
                dt.date.today() - dt.timedelta(days=30)
            ).isoformat()
            date_to = parameters.get("date_to") or dt.date.today().isoformat()
            tasks = build_backfill_tasks(start=date_from, end=date_to, **common)
            cycle_key = "backfill"
        return tasks, cycle_key

    def _check_control(self, job_id: str) -> Dict[str, Any]:
        job = self.repository.get_job(job_id)
        if not job:
            raise JobCancelled("Job was deleted")
        if job.get("cancel_requested"):
            raise JobCancelled()
        if job.get("pause_requested"):
            raise JobPaused()
        self.repository.update_job(job_id, last_heartbeat=utcnow())
        return job

    async def _discover(
        self,
        job_id: str,
        base_tasks: Sequence[SearchTask],
        cycle_key: str,
        parameters: Mapping[str, Any],
        discovery: SerpAPIClient,
        search_fallback: TinyFishClient,
    ) -> None:
        """Run up to five Google searches at once, then persist sequentially."""

        self.repository.update_job(job_id, current_stage="discovering")
        concurrency = max(1, min(10, int(parameters.get("search_concurrency") or 5)))
        max_documents = max(1, min(5000, int(parameters.get("max_documents") or 100)))
        queue: List[SearchTask] = list(base_tasks)
        split_keys: set[str] = set()
        existing_document_items = self.repository.list_items(
            job_id, item_type="document", limit=5000
        )
        job_hashes = {
            canonical_url_hash(item.get("source_url"))
            for item in existing_document_items
            if item.get("source_url")
        }

        while queue and len(job_hashes) < max_documents:
            self._check_control(job_id)
            wave = queue[:concurrency]
            del queue[:concurrency]
            runnable: List[Tuple[SearchTask, Mapping[str, Any], float]] = []
            for task in wave:
                item_key = stable_hash(
                    {"cycle": cycle_key, "kind": "query", "task": task.to_dict()}
                )
                existing = self.repository.get_item_by_key(job_id, item_key)
                if existing and existing.get("status") == "completed":
                    continue
                item = self.repository.upsert_item(
                    {
                        "job_id": job_id,
                        "item_type": "query",
                        "idempotency_key": item_key,
                        "query_text": task.query,
                        "stage": "discovering",
                        "status": "running",
                        "attempts": int((existing or {}).get("attempts") or 0) + 1,
                        "checkpoint": task.to_dict(),
                        "started_at": (existing or {}).get("started_at") or utcnow(),
                        "last_heartbeat": utcnow(),
                    }
                )
                runnable.append((task, item, time.monotonic()))

            if not runnable:
                continue
            responses = await asyncio.gather(
                *(discovery.search_task(task) for task, _, _ in runnable),
                return_exceptions=True,
            )
            for (task, item, request_started), response in zip(runnable, responses):
                search_provider = "serpapi"
                if (
                    isinstance(response, SerpAPIError)
                    and response.status_code == 429
                ):
                    self.repository.add_usage(
                        job_id,
                        "serpapi",
                        "search",
                        status="failed",
                        duration_ms=int((time.monotonic() - request_started) * 1000),
                        details={
                            "query": task.query,
                            "page": task.page,
                            "error": str(response),
                            "fallback": "tinyfish",
                        },
                    )
                    fallback_started = time.monotonic()
                    try:
                        response = await search_fallback.search_task(task)
                        search_provider = "tinyfish"
                        self.repository.add_usage(
                            job_id,
                            "tinyfish",
                            "search_fallback",
                            duration_ms=int(
                                (time.monotonic() - fallback_started) * 1000
                            ),
                            details={
                                "query": task.query,
                                "page": task.page,
                                "reason": "serpapi_429",
                            },
                        )
                        self.repository.add_event(
                            job_id,
                            "discovering",
                            "SerpAPI hourly limit reached; TinyFish Search fallback completed",
                            severity="warning",
                            details={"query": task.query, "page": task.page},
                        )
                    except BaseException as fallback_error:
                        response = fallback_error
                if isinstance(response, BaseException):
                    self.repository.update_item(
                        str(item["id"]), status="failed", last_error=str(response)[:2000]
                    )
                    self.repository.increment_job(job_id, failed_count=1)
                    self.repository.add_event(
                        job_id,
                        "discovering",
                        "Discovery search failed",
                        severity="error",
                        details={"query": task.query, "page": task.page, "error": str(response)},
                    )
                    continue

                results = list(response.get("results") or [])
                if search_provider == "serpapi":
                    self.repository.add_usage(
                        job_id,
                        "serpapi",
                        "search",
                        duration_ms=int(
                            (time.monotonic() - request_started) * 1000
                        ),
                        details={
                            "query": task.query,
                            "page": task.page,
                            "results": len(results),
                        },
                    )
                for result in results:
                    if len(job_hashes) >= max_documents:
                        break
                    url_hash = self._persist_discovery(
                        job_id,
                        task,
                        result,
                        cycle_key,
                        str(item["id"]),
                        search_provider,
                    )
                    if url_hash:
                        job_hashes.add(url_hash)
                self.repository.update_item(
                    str(item["id"]),
                    status="completed",
                    completed_at=utcnow(),
                    checkpoint={
                        **task.to_dict(),
                        "result_count": len(results),
                        "search_provider": search_provider,
                    },
                    last_error=None,
                )
                self.repository.add_event(
                    job_id,
                    "discovering",
                    "Search page completed",
                    details={
                        "provider": search_provider,
                        "query": task.query,
                        "page": task.page,
                        "results": len(results),
                    },
                )

                if len(results) >= 10 and task.page + 1 < self._max_pages:
                    queue.append(replace(task, page=task.page + 1))
                elif (
                    len(results) >= 10
                    and task.page + 1 >= self._max_pages
                    and task.window is not None
                    and task.window.granularity == "month"
                    and parameters.get("split_saturated_windows", True)
                ):
                    split_key = stable_hash(
                        {**task.to_dict(), "page": 0, "window": task.window.to_dict()}
                    )
                    if split_key not in split_keys:
                        split_keys.add(split_key)
                        queue.extend(split_saturated_task(replace(task, page=0), max_pages=1))

        document_items = self.repository.list_items(job_id, item_type="document", limit=5000)
        self.repository.update_job(job_id, total_items=len(document_items))
        if len(job_hashes) >= max_documents:
            self.repository.add_event(
                job_id,
                "discovering",
                "Document cap reached; remaining search tasks skipped",
                severity="warning",
                details={"max_documents": max_documents},
            )

    def _persist_discovery(
        self,
        job_id: str,
        task: SearchTask,
        result: Mapping[str, Any],
        cycle_key: str,
        query_item_id: str,
        search_provider: str = "serpapi",
    ) -> Optional[str]:
        canonical_url = canonicalize_url(result.get("url") or result.get("link"))
        url_hash = canonical_url_hash(canonical_url)
        if not canonical_url or not url_hash:
            return None
        existing = self.repository.get_document_by_hash(url_hash)
        now = utcnow()
        document = self.repository.upsert_document(
            {
                "canonical_url": canonical_url,
                "url_hash": url_hash,
                "platform": infer_platform(canonical_url),
                "title": result.get("title") or (existing or {}).get("title"),
                "language": task.language,
                "published_at": _iso_timestamp(result.get("date"))
                or (existing or {}).get("published_at"),
                "first_seen_at": (existing or {}).get("first_seen_at") or now,
                "last_seen_at": now,
                "search_title": result.get("title"),
                "search_snippet": result.get("snippet"),
                "search_rank": result.get("position"),
                "search_query": task.query,
                "raw_metadata": {"search": dict(result), "search_task": task.to_dict()},
            }
        )
        query_fingerprint = stable_hash(task.to_dict())
        if hasattr(self.repository, "upsert_discovery"):
            self.repository.upsert_discovery(
                job_id=job_id,
                query_item_id=query_item_id,
                document_id=str(document["id"]),
                search_provider=search_provider,
                query_fingerprint=query_fingerprint,
                query_text=task.query,
                result=result,
            )
        item_key = stable_hash(
            {"cycle": cycle_key, "kind": "document", "url_hash": url_hash}
        )
        existing_item = self.repository.get_item_by_key(job_id, item_key)
        if not existing_item:
            self.repository.upsert_item(
                {
                    "job_id": job_id,
                    "item_type": "document",
                    "idempotency_key": item_key,
                    "query_text": task.query,
                    "source_url": canonical_url,
                    "document_id": document["id"],
                    "stage": "fetching",
                    "status": "queued",
                    "checkpoint": {"search_task": task.to_dict()},
                }
            )
            self.repository.increment_job(job_id, discovered_count=1)
        else:
            self.repository.increment_job(job_id, deduplicated_count=1)
        if existing:
            self.repository.increment_job(job_id, deduplicated_count=1)
        return url_hash

    async def _process_documents(
        self,
        job_id: str,
        parameters: Mapping[str, Any],
        tinyfish: TinyFishClient,
        analyzer: OpenAIAnalysisClient,
    ) -> None:
        items = self.repository.list_items(job_id, item_type="document", limit=5000)
        pending = [item for item in items if item.get("status") != "completed"]
        self.repository.update_job(job_id, total_items=len(items), current_stage="fetching")
        batch_size = max(1, min(10, int(parameters.get("fetch_concurrency") or 5)))
        for batch in _chunks(pending, batch_size):
            self._check_control(job_id)
            await self._process_fetch_batch(job_id, batch, parameters, tinyfish, analyzer)
            await self._refresh_live_analytics(job_id)

    async def _process_fetch_batch(
        self,
        job_id: str,
        items: Sequence[Mapping[str, Any]],
        parameters: Mapping[str, Any],
        tinyfish: TinyFishClient,
        analyzer: OpenAIAnalysisClient,
    ) -> None:
        active: List[Mapping[str, Any]] = []
        for item in items:
            self.repository.update_item(
                str(item["id"]),
                status="running",
                stage="fetching",
                attempts=int(item.get("attempts") or 0) + 1,
                started_at=item.get("started_at") or utcnow(),
                last_heartbeat=utcnow(),
            )
            active.append(item)
        urls = [str(item["source_url"]) for item in active]
        request_started = time.monotonic()
        try:
            response = await tinyfish.fetch_urls(urls)
        except Exception as exc:
            for item in active:
                self._fail_item(job_id, item, "fetching", exc)
            return

        self.repository.add_usage(
            job_id,
            "tinyfish",
            "fetch",
            units=len(urls),
            duration_ms=int((time.monotonic() - request_started) * 1000),
            details={"url_count": len(urls)},
        )
        results = {
            canonicalize_url(result.get("url") or result.get("final_url")): result
            for result in response.get("results") or []
        }
        errors = {
            canonicalize_url(error.get("url")): error
            for error in response.get("errors") or []
        }
        ready: List[Tuple[Mapping[str, Any], Mapping[str, Any]]] = []
        for item in active:
            url = canonicalize_url(item.get("source_url"))
            result = results.get(url)
            if not result:
                self._fail_item(
                    job_id,
                    item,
                    "fetching",
                    RuntimeError(str(errors.get(url) or "TinyFish Fetch returned no result")),
                )
                continue
            ready.append((item, result))

        # Manual Agent calls are serialized to keep its shared record budget exact.
        if bool(parameters.get("manual_deep_scan", False)):
            for item, result in ready:
                await self._enrich_and_analyze(
                    job_id, item, result, parameters, tinyfish, analyzer
                )
        else:
            await asyncio.gather(
                *(
                    self._enrich_and_analyze(
                        job_id, item, result, parameters, tinyfish, analyzer
                    )
                    for item, result in ready
                )
            )

    async def _enrich_and_analyze(
        self,
        job_id: str,
        item: Mapping[str, Any],
        fetch_result: Mapping[str, Any],
        parameters: Mapping[str, Any],
        tinyfish: TinyFishClient,
        analyzer: OpenAIAnalysisClient,
    ) -> None:
        document_id = str(item["document_id"])
        existing = self.repository.get_document(document_id) or {}
        body = _text(fetch_result.get("text"))
        image_links = [str(url) for url in fetch_result.get("image_links") or [] if url]
        document = self.repository.upsert_document(
            {
                "canonical_url": existing.get("canonical_url") or item.get("source_url"),
                "url_hash": existing.get("url_hash") or canonical_url_hash(item.get("source_url")),
                "platform": existing.get("platform") or infer_platform(item.get("source_url")),
                "author_display_name": fetch_result.get("author"),
                "title": fetch_result.get("title") or existing.get("title"),
                "body": body,
                "language": fetch_result.get("language") or existing.get("language"),
                "published_at": _iso_timestamp(fetch_result.get("published_date"))
                or existing.get("published_at"),
                "first_seen_at": existing.get("first_seen_at") or utcnow(),
                "last_seen_at": utcnow(),
                "fetched_at": utcnow(),
                "fetch_status": "completed",
                "search_title": existing.get("search_title"),
                "search_snippet": existing.get("search_snippet"),
                "search_rank": existing.get("search_rank"),
                "search_query": existing.get("search_query"),
                "content_hash": stable_hash(body) if body else None,
                "raw_metadata": {
                    "search": (existing.get("raw_metadata") or {}).get("search", {}),
                    "fetch": dict(fetch_result),
                },
            }
        )
        if str(item.get("stage") or "") not in {
            "deep_enriching",
            "classifying",
            "extracting",
            "completed",
        }:
            self.repository.increment_job(job_id, fetched_count=1)
        self.repository.add_event(
            job_id,
            "fetching",
            "Document fetched",
            details={"url": document["canonical_url"], "text_chars": len(body)},
        )

        media: List[Mapping[str, Any]] = [
            {"source_url": url, "media_type": "image", "vision_status": "pending"}
            for url in image_links
        ]
        comments: List[Mapping[str, Any]] = []
        agent_run: Optional[Mapping[str, Any]] = None
        current_job = self.repository.get_job(job_id) or {}
        manual_agent = bool(parameters.get("manual_deep_scan", False))
        budget = int(current_job.get("agent_budget") or 0)
        used = int(current_job.get("agent_used") or 0)
        if manual_agent and used < budget:
            self.repository.update_job(job_id, current_stage="deep_enriching")
            self.repository.update_item(
                str(item["id"]), stage="deep_enriching", last_heartbeat=utcnow()
            )
            started = time.monotonic()
            try:
                agent_run = await tinyfish.run_agent(
                    str(document["canonical_url"]),
                    comment_limit=max(0, min(10, int(parameters.get("agent_comment_limit") or 10))),
                    max_duration_seconds=max(
                        30, min(180, int(parameters.get("agent_timeout_seconds") or 180))
                    ),
                    browser_profile="stealth",
                )
                result = agent_run.get("result") or {}
                if isinstance(result, str):
                    result = json.loads(result)
                if not isinstance(result, Mapping):
                    result = {}
                comments = list(result.get("comments") or [])
                media = list(result.get("media") or media)
                agent_text = _text(result.get("post_text"))
                if len(agent_text) > len(body):
                    body = agent_text
                document = self.repository.upsert_document(
                    {
                        **document,
                        "body": body,
                        "author_display_name": result.get("author_display_name")
                        or document.get("author_display_name"),
                        "published_at": _iso_timestamp(result.get("published_at"))
                        or document.get("published_at"),
                        "content_hash": stable_hash(body) if body else None,
                        "agent_enriched": True,
                    }
                )
                self.repository.replace_comments(document_id, comments)
                steps = int(agent_run.get("num_of_steps") or len(agent_run.get("steps") or []))
                self.repository.add_usage(
                    job_id,
                    "tinyfish",
                    "agent",
                    document_id=document_id,
                    request_id=agent_run.get("run_id"),
                    units=steps or 1,
                    duration_ms=int((time.monotonic() - started) * 1000),
                    details={"steps": steps, "status": agent_run.get("status")},
                )
                self.repository.increment_job(job_id, agent_count=1, agent_used=1)
            except Exception as exc:
                self.repository.add_event(
                    job_id,
                    "deep_enriching",
                    "Manual Agent scan failed; continuing with Fetch evidence",
                    severity="warning",
                    details={"url": document["canonical_url"], "error": str(exc)},
                )

        self.repository.replace_media(
            document_id,
            media,
            str(agent_run.get("run_id") or "") if agent_run else None,
        )
        self.repository.update_job(job_id, current_stage="classifying")
        self.repository.update_item(
            str(item["id"]), stage="classifying", last_heartbeat=utcnow()
        )
        selected_images = self._select_vision_images(body, image_links, parameters)
        selected_image_set = set(selected_images)
        analysis_media = (
            media
            if agent_run
            else [
                media_item
                for media_item in media
                if str(
                    media_item.get("source_url")
                    or media_item.get("image_url")
                    or ""
                )
                in selected_image_set
            ]
        )
        evidence = self._evidence_bundle(
            document, body, comments, analysis_media, parameters
        )
        started = time.monotonic()
        try:
            analysis = await analyzer.classify(
                evidence,
                image_urls=selected_images,
                max_image_urls=max(0, min(2, int(parameters.get("max_vision_images") or 2))),
            )
            classification = analysis.classification
            self.repository.upsert_classification(
                document_id,
                classification,
                job_id=job_id,
                provider="openai",
                model=analysis.model,
                prompt_version=analysis.prompt_version,
            )
            indicator_count = self.repository.upsert_indicators(
                document_id, classification.get("indicators") or []
            )
            findings = self._merge_media_findings(
                media,
                classification.get("media_findings") or [],
                analysis.model,
                selected_images,
                analysis.vision_fallback_reason,
            )
            if findings:
                self.repository.replace_media(document_id, findings, None)
            usage = analysis.usage
            self.repository.add_usage(
                job_id,
                "openai",
                "item_analysis",
                document_id=document_id,
                request_id=analysis.response_id,
                model=analysis.model,
                input_tokens=usage.get("input_tokens"),
                output_tokens=usage.get("output_tokens"),
                total_tokens=usage.get("total_tokens"),
                duration_ms=int((time.monotonic() - started) * 1000),
                details={
                    "indicators": indicator_count,
                    "vision_images": len(selected_images),
                    "vision_fallback_reason": analysis.vision_fallback_reason,
                },
            )
            self.repository.upsert_document({**document, "classification_status": "completed"})
            self.repository.update_item(
                str(item["id"]),
                stage="completed",
                status="completed",
                completed_at=utcnow(),
                last_error=None,
            )
            self.repository.increment_job(job_id, classified_count=1)
            self.repository.add_event(
                job_id,
                "classifying",
                "Document analyzed by GPT-5.6 Luna",
                details={
                    "url": document["canonical_url"],
                    "category": classification.get("primary_category"),
                    "confidence": classification.get("confidence"),
                    "indicators": indicator_count,
                    "vision_images": len(selected_images),
                },
            )
        except Exception as exc:
            self.repository.upsert_document({**document, "classification_status": "failed"})
            self.repository.add_usage(
                job_id,
                "openai",
                "item_analysis",
                document_id=document_id,
                model=self.settings.openai_model,
                status="failed",
                duration_ms=int((time.monotonic() - started) * 1000),
                details={"error": str(exc)},
            )
            self._fail_item(job_id, item, "classifying", exc)

    @staticmethod
    def _select_vision_images(
        body: str, image_links: Sequence[str], parameters: Mapping[str, Any]
    ) -> List[str]:
        if not bool(parameters.get("enable_vision", True)) or not image_links:
            return []
        max_images = max(0, min(2, int(parameters.get("max_vision_images") or 2)))
        mode = str(parameters.get("vision_mode") or "relevant").lower()
        lowered = body.casefold()
        relevant_terms = (
            "lừa", "scam", "chuyển khoản", "tài khoản", "qr", "mất tiền",
            "giả mạo", "phishing", "số điện thoại", "biên lai",
        )
        relevant = mode == "all" or len(body.strip()) < 400 or any(
            term in lowered for term in relevant_terms
        )
        return list(dict.fromkeys(image_links))[:max_images] if relevant else []

    @staticmethod
    def _merge_media_findings(
        media: Sequence[Mapping[str, Any]],
        findings: Sequence[Mapping[str, Any]],
        model: str,
        vision_image_urls: Sequence[str],
        fallback_reason: Optional[str],
    ) -> List[Mapping[str, Any]]:
        selected = set(vision_image_urls)
        merged: Dict[str, Dict[str, Any]] = {}
        for item in media:
            url = str(item.get("source_url") or item.get("image_url") or "")
            if url:
                merged[url] = dict(item)
        for finding in findings:
            url = str(finding.get("image_url") or finding.get("source_url") or "")
            if not url or url not in selected:
                continue
            row = merged.setdefault(url, {"source_url": url, "media_type": "image"})
            row.update(dict(finding))
            row.update(
                {
                    "source_url": url,
                    "vision_status": "completed" if not fallback_reason else "failed",
                    "vision_provider": "openai",
                    "vision_model": model,
                    "vision_confidence": finding.get("confidence"),
                    "analyzed_at": utcnow(),
                }
            )
        for url in selected:
            row = merged.setdefault(url, {"source_url": url, "media_type": "image"})
            if not row.get("vision_provider"):
                row.update(
                    {
                        "vision_status": "failed" if fallback_reason else "completed",
                        "vision_provider": "openai",
                        "vision_model": model,
                        "analyzed_at": utcnow(),
                    }
                )
        return list(merged.values())

    @staticmethod
    def _evidence_bundle(
        document: Mapping[str, Any],
        body: str,
        comments: Sequence[Mapping[str, Any]],
        media: Sequence[Mapping[str, Any]],
        parameters: Mapping[str, Any],
    ) -> Dict[str, Any]:
        return {
            "monitored_keywords": _list(parameters.get("keywords"), ()),
            "source": {
                "url": document.get("canonical_url"),
                "platform": document.get("platform"),
                "title": document.get("title"),
                "author": document.get("author_display_name"),
                "published_at": document.get("published_at"),
                "search_snippet": document.get("search_snippet"),
            },
            "post_text": body[:12000],
            "comments": [
                {
                    "author": item.get("author_display_name"),
                    "text": _text(item.get("body") or item.get("text"))[:2000],
                    "published_at": item.get("published_at"),
                }
                for item in comments[:10]
            ],
            "media": [
                {
                    "source_url": item.get("source_url") or item.get("image_url"),
                    "description": item.get("visual_description")
                    or item.get("visual_evidence")
                    or item.get("description"),
                    "visible_text": item.get("visible_text") or item.get("extracted_text"),
                    "qr_present": item.get("qr_present"),
                    "qr_payload": item.get("qr_payload"),
                }
                for item in media[:20]
            ],
        }

    def _analytics_input(self) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
        rows = self.repository.list_global_analysis_documents(limit=5000)
        documents: List[Dict[str, Any]] = []
        urls: Dict[str, str] = {}
        for row in rows:
            classification = _embedded_one(row.get("classifications"))
            if not classification:
                continue
            indicators: List[Dict[str, Any]] = []
            for edge in row.get("document_indicators") or []:
                if not isinstance(edge, Mapping):
                    continue
                indicator = _embedded_one(edge.get("indicators"))
                if not indicator:
                    continue
                indicators.append(
                    {
                        "kind": indicator.get("kind"),
                        "normalized_value": indicator.get("normalized_value"),
                        "display_value": indicator.get("display_value"),
                        "confidence": edge.get("confidence"),
                        "evidence_source": edge.get("evidence_source"),
                        "evidence_quote": edge.get("evidence_quote"),
                    }
                )
            document_id = str(row["id"])
            url = str(row.get("canonical_url") or "")
            if url:
                urls[document_id] = url
            documents.append(
                {
                    "document_id": document_id,
                    "primary_category": classification.get("primary_category"),
                    "confidence": classification.get("confidence"),
                    "severity": classification.get("severity"),
                    "scam_types": classification.get("scam_types") or [],
                    "bank_roles": classification.get("bank_roles") or [],
                    "indicators": indicators,
                }
            )
        return documents, urls

    async def _refresh_live_analytics(self, job_id: str) -> Optional[Dict[str, Any]]:
        if not hasattr(self.repository, "list_global_analysis_documents"):
            return None
        self.repository.update_job(job_id, current_stage="clustering")
        documents, _ = self._analytics_input()
        analytics = analyze_documents(documents)
        counts = self.repository.replace_live_analytics(job_id, analytics)
        self.repository.add_event(
            job_id,
            "clustering",
            "Global metrics and campaign graph refreshed",
            details={"documents": len(documents), **counts},
        )
        return analytics

    async def _generate_grounded_insights(
        self,
        job_id: str,
        parameters: Mapping[str, Any],
        analyzer: OpenAIAnalysisClient,
    ) -> None:
        if not bool(parameters.get("generate_insights", True)):
            return
        if not hasattr(self.repository, "list_campaign_clusters"):
            return
        self.repository.update_job(job_id, current_stage="summarizing")
        documents, document_urls = self._analytics_input()
        clusters = self.repository.list_campaign_clusters(limit=30)
        anomalies = self.repository.list_anomalies(limit=50)
        if not documents:
            return
        context = {
            "metrics": self.repository.list_analysis_metrics(limit=100),
            "clusters": clusters,
            "anomalies": anomalies,
            "documents": [
                {"document_id": item["document_id"], "url": document_urls.get(item["document_id"])}
                for item in documents[:300]
            ],
        }
        started = time.monotonic()
        try:
            result = await analyzer.summarize_insights(context)
            count = self.repository.upsert_grounded_insights(
                job_id=job_id,
                summary=result.summary,
                model=result.model,
                prompt_version="scamdna-insight-v1",
                document_urls=document_urls,
            )
            usage = result.usage
            self.repository.add_usage(
                job_id,
                "openai",
                "grounded_insights",
                request_id=result.response_id,
                model=result.model,
                input_tokens=usage.get("input_tokens"),
                output_tokens=usage.get("output_tokens"),
                total_tokens=usage.get("total_tokens"),
                duration_ms=int((time.monotonic() - started) * 1000),
                details={"insight_count": count},
            )
            self.repository.add_event(
                job_id,
                "summarizing",
                "Grounded insight summaries refreshed",
                details={"insight_count": count},
            )
        except Exception as exc:
            # Aggregate summaries are derivative; never fail the evidence pipeline.
            self.repository.add_event(
                job_id,
                "summarizing",
                "Grounded insight summary failed; classified data remains usable",
                severity="warning",
                details={"error": str(exc)},
            )

    def _fail_item(
        self,
        job_id: str,
        item: Mapping[str, Any],
        stage: str,
        error: BaseException,
    ) -> None:
        self.repository.update_item(
            str(item["id"]), status="failed", stage=stage, last_error=str(error)[:2000]
        )
        self.repository.increment_job(job_id, failed_count=1)
        self.repository.add_event(
            job_id,
            stage,
            "Document processing failed",
            severity="error",
            details={"url": item.get("source_url"), "error": str(error)},
        )

    async def _finish_cycle(
        self,
        job_id: str,
        job: Mapping[str, Any],
        parameters: Mapping[str, Any],
        started: float,
    ) -> None:
        if str(job.get("mode")) == "continuous":
            interval = max(5, int(parameters.get("monitor_interval_minutes") or 15))
            next_run = (
                dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=interval)
            ).isoformat()
            status = "monitoring"
            finished_at = None
        else:
            next_run = None
            status = "completed"
            finished_at = utcnow()
        self.repository.update_job(
            job_id,
            status=status,
            current_stage="completed",
            finished_at=finished_at,
            next_run_at=next_run,
            last_heartbeat=utcnow(),
        )
        self.repository.add_event(
            job_id,
            "completed",
            "Crawl cycle completed",
            details={
                "duration_seconds": round(time.monotonic() - started, 2),
                "next_run_at": next_run,
            },
        )
