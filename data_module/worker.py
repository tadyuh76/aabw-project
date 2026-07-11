from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from typing import Optional

from .config import Settings
from .db import SupabaseRepository
from .orchestrator import CrawlPipeline

logger = logging.getLogger("scamdna.worker")
_stop_requested = False


def _request_stop(signum: int, _frame: object) -> None:
    global _stop_requested
    logger.info("Stop requested (signal %s); finishing the current safe step", signum)
    _stop_requested = True


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # httpx logs full request URLs at INFO; SerpAPI places its key in the query
    # string, so keep transport chatter out of the local hackathon console.
    logging.getLogger("httpx").setLevel(logging.WARNING)


def run_worker(
    settings: Settings,
    *,
    once: bool = False,
    job_id: Optional[str] = None,
) -> int:
    repository = SupabaseRepository(settings)
    processed = 0

    while not _stop_requested:
        try:
            recovered = repository.recover_stale_items()
            if recovered:
                logger.warning("Recovered %s stale crawl items", recovered)

            if job_id:
                job = repository.get_job(job_id)
                jobs = [job] if job else []
            else:
                jobs = repository.list_runnable_jobs(limit=20)
        except Exception:
            logger.exception(
                "Supabase control-plane poll failed; retrying without stopping worker"
            )
            time.sleep(settings.worker_poll_seconds)
            continue

        if not jobs:
            if once or job_id:
                return processed
            time.sleep(settings.worker_poll_seconds)
            continue

        for job in jobs:
            if _stop_requested:
                break
            if not job:
                continue
            try:
                # The Streamlit Settings tab can rotate provider keys while this
                # process stays alive. Reload them before every new job.
                live_settings = Settings.from_env(require_all=True)
                pipeline = CrawlPipeline(live_settings, repository)
                pipeline.run_job(job)
            except Exception:
                logger.exception("Job %s crashed", job.get("id"))
            processed += 1
            if once or job_id:
                return processed

    return processed


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="Run the ScamDNA crawler worker")
    parser.add_argument("--once", action="store_true", help="Process at most one job")
    parser.add_argument("--job-id", help="Process only one explicit job")
    args = parser.parse_args(argv)

    settings = Settings.from_env(require_all=True)
    configure_logging(settings.log_level)
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)
    run_worker(settings, once=args.once, job_id=args.job_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
