"""Create and run bounded MB Bank year-to-date crawl shards.

This is a hackathon operations helper, not a scheduler.  It creates one job for
each calendar month and domain group, then runs explicit worker subprocesses so
several independent Supabase-backed jobs can make progress at once.
"""

from __future__ import annotations

import argparse
import asyncio
import calendar
import concurrent.futures
import datetime as dt
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .config import Settings
from .db import SupabaseRepository, utcnow
from .orchestrator import CrawlPipeline
from .pipeline import OpenAIAnalysisClient, analyze_documents


PROJECT_ROOT = Path(__file__).resolve().parents[1]
KEYWORDS: Tuple[str, ...] = ("MB Bank", "MBBank")
COMBINED_INTENT_GROUPS: Tuple[str, ...] = (
    "bị lừa|bóc phốt|lừa đảo|chuyển khoản|mất tiền",
    "giả mạo|link giả|app giả|số tài khoản|số điện thoại",
)
DOMAIN_GROUPS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    (
        "meta_tiktok",
        (
            "facebook.com",
            "instagram.com",
            "threads.net",
            "threads.com",
            "tiktok.com",
        ),
    ),
    ("x_reddit", ("x.com", "twitter.com", "reddit.com")),
)


@dataclass(frozen=True)
class BackfillShard:
    """One monthly, domain-bounded crawl job."""

    year: int
    month: int
    group: str
    domains: Tuple[str, ...]
    date_from: dt.date
    date_to: dt.date

    def job_name(self, cap: int) -> str:
        return "ScamDNA YTD {:04d}-{:02d} | MB Bank | {} | cap={}".format(
            self.year,
            self.month,
            self.group,
            cap,
        )


def build_ytd_shards(
    year: int,
    *,
    today: Optional[dt.date] = None,
    domain_groups: Sequence[Tuple[str, Sequence[str]]] = DOMAIN_GROUPS,
) -> List[BackfillShard]:
    """Return calendar-month shards from January through the requested YTD end.

    A past year produces all twelve months. A future year is rejected because
    it cannot contain a year-to-date crawl window.
    """

    current = today or dt.date.today()
    if year < 1:
        raise ValueError("year must be positive")
    if year > current.year:
        raise ValueError("year cannot be in the future")

    last_month = current.month if year == current.year else 12
    shards: List[BackfillShard] = []
    for month in range(1, last_month + 1):
        first = dt.date(year, month, 1)
        month_end = dt.date(year, month, calendar.monthrange(year, month)[1])
        last = min(month_end, current) if year == current.year else month_end
        for group, domains in domain_groups:
            clean_domains = tuple(str(domain).strip() for domain in domains if str(domain).strip())
            if not str(group).strip() or not clean_domains:
                raise ValueError("every domain group needs a name and at least one domain")
            shards.append(
                BackfillShard(
                    year=year,
                    month=month,
                    group=str(group).strip(),
                    domains=clean_domains,
                    date_from=first,
                    date_to=last,
                )
            )
    return shards


def shard_job_payload(shard: BackfillShard, cap: int) -> Dict[str, Any]:
    """Build the locked fast-path parameters for one shard."""

    if cap < 1:
        raise ValueError("cap must be positive")
    return {
        "name": shard.job_name(cap),
        "mode": "backfill",
        "parameters": {
            "keywords": list(KEYWORDS),
            "target_domains": list(shard.domains),
            "scam_intents": list(COMBINED_INTENT_GROUPS),
            "language": "vi",
            "location": "VN",
            "date_from": shard.date_from.isoformat(),
            "date_to": shard.date_to.isoformat(),
            "max_search_pages": 5,
            "search_concurrency": 5,
            "max_documents": cap,
            "fetch_concurrency": 5,
            "enable_vision": True,
            "vision_mode": "relevant",
            "max_vision_images": 2,
            "manual_deep_scan": False,
            "enable_agent_enrichment": False,
            "agent_record_limit": 0,
            "agent_comment_limit": 0,
            "agent_timeout_seconds": 0,
            "generate_insights": False,
            "split_saturated_windows": True,
        },
    }


def _jobs_by_exact_name(rows: Iterable[Mapping[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Keep the newest row for every exact name (list_jobs is newest first)."""

    result: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        name = str(row.get("name") or "")
        if name and name not in result:
            result[name] = dict(row)
    return result


def create_or_reuse_jobs(
    repository: SupabaseRepository,
    shards: Sequence[BackfillShard],
    *,
    cap: int,
    rerun_completed: bool = False,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Return ``(all shard jobs, jobs to execute)`` without duplicate names."""

    existing = _jobs_by_exact_name(repository.list_jobs(limit=500))
    all_jobs: List[Dict[str, Any]] = []
    runnable: List[Dict[str, Any]] = []

    for shard in shards:
        payload = shard_job_payload(shard, cap)
        name = str(payload["name"])
        job = existing.get(name)
        if job is None:
            job = repository.create_job(payload)
            existing[name] = dict(job)
            print("created  {}  {}".format(job["id"], name), flush=True)
        else:
            print(
                "reused   {}  {}  [{}]".format(job["id"], name, job.get("status")),
                flush=True,
            )

        # Extend the current-month end date when a previously created shard is
        # deliberately rerun later in the year. Other locked parameters remain
        # deterministic because the cap is part of the exact job name.
        if str(job.get("status")) in {"queued", "failed"} or (
            str(job.get("status")) == "completed" and rerun_completed
        ):
            updated = repository.update_job(
                str(job["id"]),
                parameters=payload["parameters"],
                pause_requested=False,
                cancel_requested=False,
            )
            if updated:
                job = updated

        all_jobs.append(dict(job))
        status = str(job.get("status") or "")
        if status == "completed" and not rerun_completed:
            print("skipped  {}  already completed".format(name), flush=True)
        elif status in {"queued", "failed"} or (
            status == "completed" and rerun_completed
        ):
            runnable.append(dict(job))
        elif status == "running":
            print("skipped  {}  already running".format(name), flush=True)
        else:
            print(
                "skipped  {}  unsupported status [{}]".format(name, status),
                flush=True,
            )

    return all_jobs, runnable


def _run_worker_subprocess(job: Mapping[str, Any]) -> Tuple[str, int, str]:
    job_id = str(job["id"])
    completed = subprocess.run(
        [sys.executable, "-m", "data_module.worker", "--job-id", job_id],
        cwd=str(PROJECT_ROOT),
        text=True,
        capture_output=True,
        check=False,
    )
    diagnostic = (completed.stderr or completed.stdout or "").strip()
    if len(diagnostic) > 2000:
        diagnostic = diagnostic[-2000:]
    return job_id, completed.returncode, diagnostic


def run_jobs(
    repository: SupabaseRepository,
    jobs: Sequence[Mapping[str, Any]],
    *,
    parallel: int,
) -> Dict[str, str]:
    """Run explicit worker processes and return the final Supabase statuses."""

    if parallel < 1:
        raise ValueError("parallel must be positive")
    if not jobs:
        return {}

    statuses: Dict[str, str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=parallel) as executor:
        futures = {
            executor.submit(_run_worker_subprocess, job): dict(job) for job in jobs
        }
        for future in concurrent.futures.as_completed(futures):
            job = futures[future]
            job_id = str(job["id"])
            try:
                _, return_code, diagnostic = future.result()
            except Exception as exc:
                return_code = -1
                diagnostic = str(exc)
            latest = repository.get_job(job_id) or {}
            status = str(latest.get("status") or "missing")
            statuses[job_id] = status
            print(
                "finished {}  status={} worker_exit={}".format(
                    job.get("name") or job_id,
                    status,
                    return_code,
                ),
                flush=True,
            )
            # Supabase status is authoritative because a process can exit after
            # recording a provider or pipeline failure on the job row.
            if status != "completed" and diagnostic:
                print(diagnostic, file=sys.stderr, flush=True)
    return statuses


async def _refresh_global_outputs(
    settings: Settings,
    repository: SupabaseRepository,
    provenance_job_id: str,
) -> Tuple[Dict[str, int], int]:
    """Run one final deterministic graph refresh and one grounded summary."""

    pipeline = CrawlPipeline(settings, repository)
    documents, document_urls = pipeline._analytics_input()
    analytics = analyze_documents(documents)
    counts = repository.replace_live_analytics(
        provenance_job_id, analytics, prune=True
    )
    if hasattr(repository, "replace_stable_campaigns"):
        counts.update(
            repository.replace_stable_campaigns(
                provenance_job_id, analytics, prune=True
            )
        )

    context = {
        "metrics": repository.list_analysis_metrics(limit=100),
        "clusters": repository.list_campaign_clusters(limit=30),
        "anomalies": repository.list_anomalies(limit=50),
        "documents": [
            {
                "document_id": item["document_id"],
                "url": document_urls.get(item["document_id"]),
            }
            for item in documents[:300]
        ],
    }
    if not documents:
        return counts, 0

    started = time.monotonic()
    async with OpenAIAnalysisClient(
        settings.openai_api_key,
        model=settings.openai_model,
        reasoning_effort=settings.openai_reasoning_effort,
        max_image_urls=0,
    ) as analyzer:
        result = await analyzer.summarize_insights(context)
    insight_count = repository.upsert_grounded_insights(
        job_id=provenance_job_id,
        summary=result.summary,
        model=result.model,
        prompt_version="scamdna-insight-v1",
        document_urls=document_urls,
    )
    usage = result.usage
    repository.add_usage(
        provenance_job_id,
        "openai",
        "grounded_insights",
        request_id=result.response_id,
        model=result.model,
        input_tokens=usage.get("input_tokens"),
        output_tokens=usage.get("output_tokens"),
        total_tokens=usage.get("total_tokens"),
        duration_ms=int((time.monotonic() - started) * 1000),
        details={"insight_count": insight_count, "source": "ytd_backfill"},
    )
    repository.add_event(
        provenance_job_id,
        "summarizing",
        "YTD global analytics and grounded insights refreshed",
        details={**counts, "insights": insight_count},
    )
    return counts, insight_count


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create and run MB Bank monthly YTD crawl shards"
    )
    parser.add_argument("--year", type=_positive_int, default=dt.date.today().year)
    parser.add_argument("--parallel", type=_positive_int, default=14)
    parser.add_argument("--cap", type=_positive_int, default=50)
    parser.add_argument(
        "--create-only",
        action="store_true",
        help="Create/reuse the shard jobs without starting worker processes",
    )
    parser.add_argument(
        "--rerun-completed",
        action="store_true",
        help="Include completed shard jobs (normally they are skipped)",
    )
    args = parser.parse_args(argv)

    try:
        shards = build_ytd_shards(args.year)
    except ValueError as exc:
        parser.error(str(exc))
    # Creating control-plane rows only needs Supabase. Provider credentials are
    # required once subprocesses will actually execute the pipeline.
    settings = Settings.from_env(require_all=not args.create_only)
    repository = SupabaseRepository(settings)
    all_jobs, runnable = create_or_reuse_jobs(
        repository,
        shards,
        cap=args.cap,
        rerun_completed=args.rerun_completed,
    )
    print(
        "shards={} runnable={} parallel={} cap={}".format(
            len(all_jobs), len(runnable), args.parallel, args.cap
        ),
        flush=True,
    )
    if args.create_only:
        return 0

    run_jobs(repository, runnable, parallel=args.parallel)
    retry_jobs: List[Dict[str, Any]] = []
    for job in all_jobs:
        failed_items = repository.list_items(
            str(job["id"]), status="failed", limit=5000
        )
        if failed_items:
            repository.retry_failed_items(str(job["id"]))
            retry_jobs.append(repository.get_job(str(job["id"])) or dict(job))
    if retry_jobs:
        print(
            "retrying {} shard(s) with failed items once".format(len(retry_jobs)),
            flush=True,
        )
        run_jobs(repository, retry_jobs, parallel=args.parallel)

    # Counters are operational hints; normalize them to the durable item state
    # after retries so old interrupted attempts do not inflate the UI.
    for job in all_jobs:
        failed_count = len(
            repository.list_items(str(job["id"]), status="failed", limit=5000)
        )
        repository.update_job(str(job["id"]), failed_count=failed_count)
    latest_jobs = [repository.get_job(str(job["id"])) or job for job in all_jobs]
    incomplete = [
        job for job in latest_jobs if str(job.get("status") or "") != "completed"
    ]
    if incomplete:
        print(
            "Skipping final analytics because {} shard(s) are not completed:".format(
                len(incomplete)
            ),
            file=sys.stderr,
        )
        for job in incomplete:
            print(
                "- {} [{}]".format(job.get("name"), job.get("status")),
                file=sys.stderr,
            )
        return 1

    provenance_job_id = str(sorted(latest_jobs, key=lambda job: str(job["name"]))[-1]["id"])
    try:
        counts, insights = asyncio.run(
            _refresh_global_outputs(settings, repository, provenance_job_id)
        )
    except Exception as exc:
        print("Final analytics refresh failed: {}".format(exc), file=sys.stderr)
        return 1
    print(
        "global analytics refreshed: metrics={metrics} clusters={clusters} "
        "anomalies={anomalies} insights={insights}".format(
            insights=insights,
            **counts,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
