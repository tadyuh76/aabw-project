"""Local Streamlit control panel for the ScamDNA data crawler.

The UI is deliberately a thin control plane. It reads and writes crawl state through
``SupabaseRepository`` and never calls providers directly, so closing the
browser does not interrupt a running worker.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

import streamlit as st

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    from data_module.config import Settings
    from data_module.db import SupabaseRepository
except Exception as exc:  # Keep the page usable while env/dependencies are being set up.
    Settings = None  # type: ignore[assignment,misc]
    SupabaseRepository = None  # type: ignore[assignment,misc]
    _IMPORT_ERROR: Optional[Exception] = exc
else:
    _IMPORT_ERROR = None


DEFAULT_DOMAINS = (
    "facebook.com",
    "threads.net",
    "threads.com",
    "x.com",
    "twitter.com",
    "reddit.com",
    "tiktok.com",
    "instagram.com",
)

DEFAULT_SCAM_INTENTS = (
    "bị lừa",
    "bóc phốt",
    "lừa đảo",
    "giả mạo",
    "chuyển khoản",
    "mất tiền",
    "link giả",
    "app giả",
    "số tài khoản",
    "số điện thoại",
)

PIPELINE_STAGES = (
    "queued",
    "discovering",
    "fetching",
    "deep_enriching",
    "classifying",
    "extracting",
    "clustering",
    "summarizing",
    "completed",
)


def _rows(result: Any) -> list[dict[str, Any]]:
    """Normalize repository lists and raw Supabase API responses."""

    value = getattr(result, "data", result)
    if value is None:
        return []
    if isinstance(value, Mapping):
        nested = value.get("data")
        if isinstance(nested, Sequence) and not isinstance(nested, (str, bytes)):
            value = nested
        else:
            return [dict(value)]
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [dict(item) for item in value if isinstance(item, Mapping)]
    return []


def _value(row: Mapping[str, Any], *keys: str, default: Any = None) -> Any:
    """Read a field from a row or common embedded JSON objects."""

    for key in keys:
        if row.get(key) is not None:
            return row[key]
    for container_name in ("progress", "progress_counters", "parameters"):
        container = row.get(container_name)
        if not isinstance(container, Mapping):
            continue
        for key in keys:
            if container.get(key) is not None:
                return container[key]
    return default


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _as_float(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _short(value: Any, limit: int = 160) -> str:
    text = "" if value is None else str(value).strip()
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _split_lines(value: str) -> list[str]:
    return list(dict.fromkeys(item.strip() for item in re.split(r"[\n,]+", value) if item.strip()))


def _format_timestamp(value: Any) -> str:
    if value in (None, ""):
        return "—"
    return str(value).replace("T", " ").replace("Z", " UTC")


def _rerun() -> None:
    rerun = getattr(st, "rerun", None) or getattr(st, "experimental_rerun", None)
    if callable(rerun):
        rerun()


@st.cache_resource(show_spinner=False)
def _get_repository() -> Any:
    if _IMPORT_ERROR is not None or Settings is None or SupabaseRepository is None:
        raise RuntimeError(
            "Could not import data_module.config or data_module.db"
        ) from _IMPORT_ERROR

    from_env = getattr(Settings, "from_env", None)
    settings = from_env() if callable(from_env) else Settings()

    from_settings = getattr(SupabaseRepository, "from_settings", None)
    if callable(from_settings):
        return from_settings(settings)
    return SupabaseRepository(settings)


def _render_connection_error(exc: Exception) -> None:
    st.error("Supabase is not configured yet, so the crawler console cannot load data.")
    st.markdown(
        "Add the required values to the local `.env` file and restart Streamlit. "
        "At minimum, the data module expects:"
    )
    st.code(
        "SUPABASE_URL=https://<project-ref>.supabase.co\n"
        "SUPABASE_SERVICE_ROLE_KEY=<service-role-key>"
    )
    with st.expander("Configuration error details"):
        st.code(f"{type(exc).__name__}: {_short(exc, 800)}")


def _create_job(repo: Any, payload: dict[str, Any]) -> None:
    try:
        created = repo.create_job(payload)
    except Exception as exc:
        st.error(f"Could not create the crawl: {_short(exc, 500)}")
        return

    rows = _rows(created)
    job_id = rows[0].get("id") if rows else None
    if job_id:
        st.success(f"Crawl queued successfully · job `{job_id}`")
    else:
        st.success("Crawl queued successfully. Open Runs to watch progress.")


def _render_new_crawl(repo: Any) -> None:
    st.subheader("Start a crawl")
    st.caption("Create a bounded backfill or a repeating local monitoring job.")

    with st.form("new_crawl_form", clear_on_submit=False):
        job_name = st.text_input("Job name", placeholder="MB Bank · scam monitoring")

        left, right = st.columns(2)
        with left:
            keywords_text = st.text_area(
                "Bank / brand keywords and aliases",
                value="MB Bank\nMBBank",
                height=130,
                help="One per line or comma-separated.",
            )
        with right:
            domains_text = st.text_area(
                "Target domains",
                value="\n".join(DEFAULT_DOMAINS),
                height=130,
                help="One domain per line. Each domain is searched independently.",
            )

        language_col, location_col, mode_col = st.columns(3)
        with language_col:
            language = st.text_input("Language", value="vi")
        with location_col:
            location = st.text_input("Location", value="VN")
        with mode_col:
            mode_label = st.selectbox("Mode", ("One-time backfill", "Continuous monitor"))
        mode = "backfill" if mode_label == "One-time backfill" else "continuous"

        date_col, page_col, interval_col, concurrency_col = st.columns(4)
        with date_col:
            date_range = st.date_input(
                "Historical date range",
                value=(date.today() - timedelta(days=30), date.today()),
                max_value=date.today(),
            )
        with page_col:
            max_search_pages = int(
                st.number_input("Maximum search pages", min_value=1, max_value=11, value=2, step=1)
            )
        with interval_col:
            monitor_interval = int(
                st.number_input(
                    "Monitor interval (minutes)",
                    min_value=5,
                    max_value=1440,
                    value=15,
                    step=5,
                    disabled=mode != "continuous",
                )
            )
        with concurrency_col:
            fetch_concurrency = int(
                st.number_input("Fetch concurrency", min_value=1, max_value=30, value=5, step=1)
            )

        search_col, cap_col, vision_col = st.columns(3)
        with search_col:
            search_concurrency = int(
                st.number_input("SerpAPI concurrency", min_value=1, max_value=10, value=5)
            )
        with cap_col:
            max_documents = int(
                st.number_input("Unique URL cap", min_value=1, max_value=5000, value=100, step=10)
            )
        with vision_col:
            enable_vision = st.checkbox(
                "Luna vision for relevant images",
                value=True,
                help="At most two relevant images are attached to each item analysis.",
            )

        with st.expander("Search and deep-enrichment settings", expanded=False):
            scam_intents_text = st.text_area(
                "Scam intents",
                value="\n".join(DEFAULT_SCAM_INTENTS),
                height=180,
                help=(
                    "The worker combines each keyword, intent, domain, date window "
                    "and result page."
                ),
            )
            enable_agent = st.checkbox(
                "Manual TinyFish Agent deep scan",
                value=False,
                key="enable_agent_fast_default",
                help=(
                    "Agent is never automatic. Use only for a deliberately small "
                    "job that needs browser/comment inspection."
                ),
            )
            agent_col, comment_col, duration_col = st.columns(3)
            with agent_col:
                agent_record_budget = int(
                    st.number_input(
                        "Agent record budget",
                        min_value=0,
                        max_value=10_000,
                        value=5,
                        step=1,
                        disabled=not enable_agent,
                    )
                )
            with comment_col:
                agent_comment_limit = int(
                    st.number_input(
                        "Comments per post",
                        min_value=0,
                        max_value=10,
                        value=10,
                        step=1,
                        disabled=not enable_agent,
                    )
                )
            with duration_col:
                agent_timeout_seconds = int(
                    st.number_input(
                        "Agent timeout (seconds)",
                        min_value=30,
                        max_value=180,
                        value=180,
                        step=30,
                        disabled=not enable_agent,
                    )
                )

        submitted = st.form_submit_button("Start crawl", type="primary", width="stretch")

    if not submitted:
        return

    keywords = _split_lines(keywords_text)
    domains = _split_lines(domains_text)
    scam_intents = _split_lines(scam_intents_text)
    if not job_name.strip():
        st.error("Enter a job name.")
        return
    if not keywords:
        st.error("Add at least one bank or brand keyword.")
        return
    if not domains:
        st.error("Add at least one target domain.")
        return
    if not scam_intents:
        st.error("Add at least one scam intent.")
        return

    selected_dates = list(date_range) if isinstance(date_range, (tuple, list)) else [date_range]
    if len(selected_dates) != 2:
        st.error("Select both a start date and an end date.")
        return
    start_date, end_date = selected_dates
    if start_date > end_date:
        st.error("The start date must be before the end date.")
        return

    payload = {
        "name": job_name.strip(),
        "mode": mode,
        "status": "queued",
        "current_stage": "queued",
        "parameters": {
            "keywords": keywords,
            "target_domains": domains,
            "scam_intents": scam_intents,
            "language": language.strip() or "vi",
            "location": location.strip() or "VN",
            "date_from": start_date.isoformat(),
            "date_to": end_date.isoformat(),
            "max_search_pages": max_search_pages,
            "search_concurrency": search_concurrency,
            "max_documents": max_documents,
            "monitor_interval_minutes": monitor_interval if mode == "continuous" else None,
            "fetch_concurrency": fetch_concurrency,
            "enable_vision": enable_vision,
            "vision_mode": "relevant",
            "max_vision_images": 2 if enable_vision else 0,
            "manual_deep_scan": enable_agent,
            "agent_record_limit": agent_record_budget if enable_agent else 0,
            "agent_comment_limit": agent_comment_limit if enable_agent else 0,
            "agent_timeout_seconds": agent_timeout_seconds if enable_agent else 0,
        },
    }
    _create_job(repo, payload)


def _job_label(job: Mapping[str, Any]) -> str:
    name = _value(job, "name", "job_name", default="Untitled crawl")
    status = _value(job, "status", default="unknown")
    return f"{name} · {status}"


def _job_table(jobs: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "Job": _value(job, "name", "job_name", default="Untitled"),
            "Mode": _value(job, "mode", default="—"),
            "Status": _value(job, "status", default="—"),
            "Stage": _value(job, "current_stage", "stage", default="—"),
            "Discovered": _as_int(_value(job, "discovered_count")),
            "Fetched": _as_int(_value(job, "fetched_count")),
            "Agent": _as_int(_value(job, "agent_count", "agent_used")),
            "Classified": _as_int(_value(job, "classified_count")),
            "Failed": _as_int(_value(job, "failed_count")),
            "Updated": _format_timestamp(_value(job, "updated_at", "last_heartbeat")),
        }
        for job in jobs
    ]


def _request_job_action(repo: Any, job_id: str, action: str) -> None:
    try:
        repo.update_job_control(job_id, action)
    except Exception as exc:
        st.error(f"Could not {action} this job: {_short(exc, 500)}")
        return
    st.success(f"Job action sent: {action}")
    _rerun()


def _request_retry(repo: Any, job_id: str) -> None:
    try:
        repo.retry_failed_items(job_id)
    except Exception as exc:
        st.error(f"Could not retry failed items: {_short(exc, 500)}")
        return
    st.success("Failed items have been queued for retry.")
    _rerun()


def _render_runs_content(repo: Any) -> None:
    try:
        jobs = _rows(repo.list_jobs(limit=100))
    except Exception as exc:
        st.error(f"Could not load crawl runs: {_short(exc, 500)}")
        return

    if not jobs:
        st.info("No crawl runs yet. Create one in New Crawl.")
        return

    st.dataframe(_job_table(jobs), width="stretch", hide_index=True)

    actionable_jobs = [job for job in jobs if job.get("id") is not None]
    if not actionable_jobs:
        st.warning("Runs loaded, but none has an ID, so controls are unavailable.")
        return

    job_ids = [str(job["id"]) for job in actionable_jobs]
    labels = {str(job["id"]): _job_label(job) for job in actionable_jobs}
    selected_id = st.selectbox("Selected run", job_ids, format_func=lambda job_id: labels[job_id])
    selected = next(job for job in actionable_jobs if str(job["id"]) == selected_id)

    status = str(_value(selected, "status", default="unknown")).lower()
    stage = str(_value(selected, "current_stage", "stage", default="—"))
    total = _as_int(_value(selected, "total_items"))
    discovered = _as_int(_value(selected, "discovered_count"))
    deduplicated = _as_int(_value(selected, "deduplicated_count"))
    fetched = _as_int(_value(selected, "fetched_count"))
    agent = _as_int(_value(selected, "agent_count", "agent_used"))
    classified = _as_int(_value(selected, "classified_count"))
    failed = _as_int(_value(selected, "failed_count"))

    st.markdown(f"**Current stage:** `{stage}` · **Status:** `{status}`")
    if total > 0:
        completed = min(total, max(fetched, classified))
        st.progress(completed / total)
        st.caption(f"{completed:,} of {total:,} items have reached fetch or classification.")

    metric_cols = st.columns(6)
    metric_cols[0].metric("Discovered", f"{discovered:,}")
    metric_cols[1].metric("Deduplicated", f"{deduplicated:,}")
    metric_cols[2].metric("Fetched", f"{fetched:,}")
    metric_cols[3].metric("Agent", f"{agent:,}")
    metric_cols[4].metric("Classified", f"{classified:,}")
    metric_cols[5].metric("Failed", f"{failed:,}")

    if hasattr(repo, "list_provider_usage"):
        try:
            usage_rows = _rows(repo.list_provider_usage(selected_id, limit=1000))
        except Exception:
            usage_rows = []
        if usage_rows:
            usage_cols = st.columns(4)
            usage_cols[0].metric(
                "SerpAPI requests",
                sum(row.get("provider") == "serpapi" for row in usage_rows),
            )
            usage_cols[1].metric(
                "TinyFish fetch batches",
                sum(
                    row.get("provider") == "tinyfish"
                    and row.get("operation") == "fetch"
                    for row in usage_rows
                ),
            )
            usage_cols[2].metric(
                "OpenAI item calls",
                sum(
                    row.get("provider") == "openai"
                    and row.get("operation") == "item_analysis"
                    for row in usage_rows
                ),
            )
            usage_cols[3].metric(
                "OpenAI total tokens",
                f"{sum(_as_int(row.get('total_tokens')) for row in usage_rows):,}",
            )

    if _value(selected, "last_error"):
        st.warning(f"Latest error: {_short(_value(selected, 'last_error'), 500)}")

    action_cols = st.columns(5)
    if action_cols[0].button(
        "Start", disabled=status not in {"draft", "created"}, width="stretch"
    ):
        _request_job_action(repo, selected_id, "start")
    if action_cols[1].button(
        "Pause",
        disabled=status in {"paused", "completed", "cancelled", "failed"},
        width="stretch",
    ):
        _request_job_action(repo, selected_id, "pause")
    if action_cols[2].button("Resume", disabled=status != "paused", width="stretch"):
        _request_job_action(repo, selected_id, "resume")
    if action_cols[3].button(
        "Cancel", disabled=status in {"completed", "cancelled"}, width="stretch"
    ):
        _request_job_action(repo, selected_id, "cancel")
    if action_cols[4].button("Retry failed", width="stretch"):
        _request_retry(repo, selected_id)

    heartbeat = _value(selected, "last_heartbeat")
    next_run = _value(selected, "next_run_at")
    heartbeat_text = _format_timestamp(heartbeat)
    next_run_text = _format_timestamp(next_run)
    st.caption(f"Heartbeat: {heartbeat_text} · Next monitoring cycle: {next_run_text}")


_fragment = getattr(st, "fragment", None) or getattr(st, "experimental_fragment", None)
if callable(_fragment):
    try:
        _render_runs_auto = _fragment(run_every="3s")(_render_runs_content)
        _AUTO_REFRESH_AVAILABLE = True
    except (TypeError, ValueError):
        _render_runs_auto = _render_runs_content
        _AUTO_REFRESH_AVAILABLE = False
else:
    _render_runs_auto = _render_runs_content
    _AUTO_REFRESH_AVAILABLE = False


def _render_runs(repo: Any) -> None:
    header_col, refresh_col = st.columns([4, 1])
    with header_col:
        st.subheader("Crawler runs")
    with refresh_col:
        st.button("Refresh", key="refresh_runs", width="stretch")

    if _AUTO_REFRESH_AVAILABLE:
        toggle = getattr(st, "toggle", st.checkbox)
        auto_refresh = toggle(
            "Auto-refresh every 3 seconds", value=True, key="runs_auto_refresh"
        )
    else:
        auto_refresh = False
        st.caption(
            "Automatic fragment refresh is unavailable in this Streamlit version; use Refresh."
        )

    if auto_refresh:
        _render_runs_auto(repo)
    else:
        _render_runs_content(repo)


def _classification(document: Mapping[str, Any]) -> Mapping[str, Any]:
    embedded = document.get("classification")
    if isinstance(embedded, Mapping):
        return embedded
    embedded = document.get("classifications")
    if isinstance(embedded, Mapping):
        return embedded
    if isinstance(embedded, Sequence) and not isinstance(embedded, (str, bytes)):
        first = next((item for item in embedded if isinstance(item, Mapping)), None)
        if first is not None:
            return first
    return {}


def _format_indicators(document: Mapping[str, Any]) -> str:
    values = document.get("indicators") or document.get("document_indicators") or []
    if isinstance(values, Mapping):
        values = [values]
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes)):
        return _short(values, 240)

    rendered: list[str] = []
    for item in values:
        if isinstance(item, str):
            rendered.append(item)
            continue
        if not isinstance(item, Mapping):
            continue
        indicator = item.get("indicator") or item.get("indicators") or item
        if not isinstance(indicator, Mapping):
            continue
        kind = indicator.get("kind") or indicator.get("type") or indicator.get("indicator_type")
        value = (
            indicator.get("display_value")
            or indicator.get("normalized_value")
            or indicator.get("value")
        )
        if value:
            rendered.append(f"{kind}: {value}" if kind else str(value))
    return _short(", ".join(rendered), 300)


def _document_table(documents: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    table: list[dict[str, Any]] = []
    for document in documents:
        classification = _classification(document)
        media = document.get("media_evidence")
        agent_enriched = bool(
            _value(document, "agent_enriched", "agent_enriched_at", "tinyfish_agent_run_id")
        )
        media_rows = (
            list(media)
            if isinstance(media, Sequence) and not isinstance(media, (str, bytes))
            else []
        )
        vision_states = sorted(
            {
                str(item.get("vision_status"))
                for item in media_rows
                if isinstance(item, Mapping) and item.get("vision_status")
            }
        )
        table.append(
            {
                "Captured": _format_timestamp(_value(document, "published_at", "created_at")),
                "Platform": _value(document, "platform", default="—"),
                "Author": _value(document, "author", "author_name", default="—"),
                "Content": _short(_value(document, "title", "body", "search_snippet"), 180),
                "Category": _value(
                    classification,
                    "primary_category",
                    default=_value(document, "primary_category", default="—"),
                ),
                "Confidence": _as_float(
                    _value(classification, "confidence", default=_value(document, "confidence"))
                ),
                "Severity": _as_float(
                    _value(
                        classification,
                        "severity",
                        default=_value(document, "severity", default=None),
                    )
                ),
                "Indicators": _format_indicators(document) or "—",
                "Agent": "Yes" if agent_enriched else "No",
                "Vision": ", ".join(vision_states) if vision_states else "—",
                "Source": _value(document, "canonical_url", "source_url", "url", default=""),
            }
        )
    return table


def _render_data_preview(repo: Any) -> None:
    header_col, limit_col, refresh_col = st.columns([3, 1, 1])
    with header_col:
        st.subheader("Latest graph-ready evidence")
    with limit_col:
        limit = int(st.selectbox("Rows", (25, 50, 100, 200), index=1, key="preview_limit"))
    with refresh_col:
        st.write("")
        st.button("Refresh", key="refresh_preview", width="stretch")

    try:
        documents = _rows(repo.list_documents_preview(limit=limit))
    except Exception as exc:
        st.error(f"Could not load documents: {_short(exc, 500)}")
        return

    if not documents:
        st.info("No documents have reached Supabase yet.")
        return

    table = _document_table(documents)
    metric_cols = st.columns(4)
    metric_cols[0].metric("Rows loaded", f"{len(table):,}")
    metric_cols[1].metric("Classified", f"{sum(row['Category'] != '—' for row in table):,}")
    with_indicators = sum(row["Indicators"] != "—" for row in table)
    metric_cols[2].metric("With indicators", f"{with_indicators:,}")
    metric_cols[3].metric("Agent enriched", f"{sum(row['Agent'] == 'Yes' for row in table):,}")

    column_config: dict[str, Any] = {}
    link_column = getattr(getattr(st, "column_config", None), "LinkColumn", None)
    if callable(link_column):
        column_config["Source"] = link_column("Source", display_text="Open source ↗")
    st.dataframe(
        table,
        width="stretch",
        hide_index=True,
        height=520,
        column_config=column_config or None,
    )


def _render_analytics_content(repo: Any) -> None:
    try:
        metrics = _rows(repo.list_analysis_metrics(limit=500))
        clusters = _rows(repo.list_campaign_clusters(limit=200))
        anomalies = _rows(repo.list_anomalies(limit=200))
        insights = _rows(repo.list_grounded_insights(limit=100))
    except Exception as exc:
        st.error(f"Could not load live analytics: {_short(exc, 600)}")
        return

    summary_row = next(
        (
            row
            for row in metrics
            if row.get("metric_scope") == "summary"
            and row.get("metric_key") == "global"
        ),
        {},
    )
    summary = summary_row.get("metric_value") or {}
    cards = st.columns(5)
    cards[0].metric("Analyzed docs", _as_int(summary.get("document_count")))
    cards[1].metric("Indicators", _as_int(summary.get("unique_indicator_count")))
    cards[2].metric("Graph edges", _as_int(summary.get("document_indicator_edge_count")))
    cards[3].metric("Linked campaigns", len(clusters))
    cards[4].metric("Active anomalies", len(anomalies))

    cluster_tab, anomaly_tab, metric_tab, insight_tab = st.tabs(
        ("Campaign clusters", "Anomalies", "SQL metrics", "Grounded insights")
    )
    with cluster_tab:
        if not clusters:
            st.info("No strong-indicator campaign link has been found yet.")
        else:
            st.dataframe(
                [
                    {
                        "Cluster": row.get("cluster_key"),
                        "Risk": row.get("risk_score"),
                        "Documents": row.get("document_count"),
                        "Max severity": row.get("maximum_severity"),
                        "Shared indicators": ", ".join(row.get("shared_indicator_keys") or []),
                        "Scam types": ", ".join(row.get("scam_types") or []),
                        "Updated": _format_timestamp(row.get("updated_at")),
                    }
                    for row in clusters
                ],
                width="stretch",
                hide_index=True,
                height=460,
            )
    with anomaly_tab:
        if not anomalies:
            st.info("No active anomaly flag yet.")
        else:
            st.dataframe(
                [
                    {
                        "Type": row.get("anomaly_type"),
                        "Score": row.get("score"),
                        "Severity": row.get("severity"),
                        "Reason": row.get("reason"),
                        "Evidence docs": len(row.get("evidence_document_ids") or []),
                        "Detected": _format_timestamp(row.get("detected_at")),
                    }
                    for row in anomalies
                ],
                width="stretch",
                hide_index=True,
                height=460,
            )
    with metric_tab:
        st.dataframe(
            [
                {
                    "Scope": row.get("metric_scope"),
                    "Key": row.get("metric_key"),
                    "Value": json.dumps(row.get("metric_value") or {}, ensure_ascii=False),
                    "Refreshed": _format_timestamp(row.get("refreshed_at")),
                }
                for row in metrics
            ],
            width="stretch",
            hide_index=True,
            height=460,
        )
    with insight_tab:
        if not insights:
            st.info("Grounded summaries are generated at the end of each crawl cycle.")
        for insight in insights:
            st.markdown(
                f"#### {_short(insight.get('title'), 180)} · severity {insight.get('severity', '—')}"
            )
            st.write(insight.get("summary") or "")
            links = insight.get("evidence_links") or []
            if links:
                st.markdown(
                    "Evidence: "
                    + " · ".join(
                        f"[source {index + 1}]({url})" for index, url in enumerate(links)
                    )
                )


if callable(_fragment):
    try:
        _render_analytics_auto = _fragment(run_every="3s")(_render_analytics_content)
    except (TypeError, ValueError):
        _render_analytics_auto = _render_analytics_content
else:
    _render_analytics_auto = _render_analytics_content


def _render_analytics(repo: Any) -> None:
    st.subheader("Live campaign intelligence")
    st.caption(
        "Global graph refreshes after every completed Fetch + Luna batch while ingestion continues."
    )
    auto_refresh = getattr(st, "toggle", st.checkbox)(
        "Live refresh every 3 seconds", value=True, key="analytics_auto_refresh"
    )
    if auto_refresh:
        _render_analytics_auto(repo)
    else:
        st.button("Refresh analytics", key="refresh_analytics")
        _render_analytics_content(repo)


def _update_env_values(values: Mapping[str, str]) -> None:
    """Update only selected local .env entries without exposing existing secrets."""

    env_path = PROJECT_ROOT / ".env"
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    remaining = dict(values)
    updated: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        if key in remaining:
            updated.append(f"{key}={remaining.pop(key)}")
        else:
            updated.append(line)
    updated.extend(f"{key}={value}" for key, value in remaining.items())
    env_path.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")


def _render_settings() -> None:
    st.subheader("Local provider settings")
    st.caption("Keys stay in the gitignored local `.env` and are used by the next worker job.")
    current = Settings.from_env() if Settings is not None else None
    status_cols = st.columns(3)
    status_cols[0].metric("SerpAPI", "Configured" if current and current.serpapi_api_key else "Missing")
    status_cols[1].metric("OpenAI", "Configured" if current and current.openai_api_key else "Missing")
    status_cols[2].metric("TinyFish", "Configured" if current and current.tinyfish_api_key else "Missing")
    backup_keys = getattr(current, "serpapi_backup_keys", ()) if current else ()
    if backup_keys:
        st.caption(
            f"Saved SerpAPI backup keys: {len(backup_keys)} · not auto-activated"
        )
    with st.form("provider_settings_form"):
        serp_key = st.text_input(
            "New SerpAPI key", type="password", help="Leave blank to keep the existing key."
        )
        openai_key = st.text_input(
            "New OpenAI key", type="password", help="Leave blank to keep the existing key."
        )
        model = st.text_input(
            "OpenAI model", value=(current.openai_model if current else "gpt-5.6-luna")
        )
        effort = st.selectbox(
            "Reasoning effort", ("none", "low"),
            index=0 if not current or current.openai_reasoning_effort == "none" else 1,
        )
        save = st.form_submit_button("Save for next job", type="primary")
    if save:
        values = {
            "OPENAI_MODEL": model.strip() or "gpt-5.6-luna",
            "OPENAI_REASONING_EFFORT": effort,
            "DISCOVERY_PROVIDER": "serpapi",
        }
        if serp_key.strip():
            values["SERPAPI_API_KEY"] = serp_key.strip()
        if openai_key.strip():
            values["OPENAI_API_KEY"] = openai_key.strip()
        _update_env_values(values)
        st.success("Saved. New provider settings will apply to the next job a worker starts.")


def _event_table(events: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for event in events:
        details = _value(event, "details", "metadata", "data")
        if isinstance(details, (Mapping, list, tuple)):
            details = json.dumps(details, ensure_ascii=False, default=str)
        rows.append(
            {
                "Time": _format_timestamp(_value(event, "created_at", "timestamp")),
                "Severity": str(_value(event, "severity", "level", default="info")).upper(),
                "Stage": _value(event, "stage", default="—"),
                "Message": _short(_value(event, "message", "event", default=""), 400),
                "Details": _short(details, 500),
            }
        )
    return rows


def _render_logs(repo: Any) -> None:
    st.subheader("Pipeline logs")
    try:
        jobs = _rows(repo.list_jobs(limit=100))
    except Exception:
        jobs = []

    jobs_by_id = {str(job["id"]): job for job in jobs if job.get("id") is not None}
    job_options = ["All jobs", *jobs_by_id.keys()]
    filter_cols = st.columns([2, 1, 1, 1, 1])
    with filter_cols[0]:
        selected_job = st.selectbox(
            "Run",
            job_options,
            format_func=lambda value: (
                value if value == "All jobs" else _job_label(jobs_by_id[value])
            ),
        )
    with filter_cols[1]:
        stage = st.selectbox("Stage", ("All stages", *PIPELINE_STAGES))
    with filter_cols[2]:
        severity = st.selectbox("Severity", ("All levels", "info", "warning", "error"))
    with filter_cols[3]:
        limit = int(st.selectbox("Rows", (50, 100, 200, 500), index=2, key="log_limit"))
    with filter_cols[4]:
        st.write("")
        st.button("Refresh", key="refresh_logs", width="stretch")

    try:
        events = _rows(
            repo.list_events(
                job_id=None if selected_job == "All jobs" else selected_job,
                stage=None if stage == "All stages" else stage,
                severity=None if severity == "All levels" else severity,
                limit=limit,
            )
        )
    except Exception as exc:
        st.error(f"Could not load logs: {_short(exc, 500)}")
        return

    if not events:
        st.info("No events match these filters.")
        return
    st.dataframe(_event_table(events), width="stretch", hide_index=True, height=560)


def main() -> None:
    st.set_page_config(page_title="ScamDNA · Data Crawler", page_icon="🧬", layout="wide")

    title_col, context_col = st.columns([4, 1])
    with title_col:
        st.title("ScamDNA Data Crawler")
        st.caption(
            "SerpAPI → TinyFish Fetch → GPT-5.6 Luna vision/analysis → live graph → Supabase"
        )
    with context_col:
        st.success("Local control plane", icon="🟢")

    try:
        repo = _get_repository()
    except Exception as exc:
        _render_connection_error(exc)
        st.stop()

    new_tab, runs_tab, preview_tab, analytics_tab, logs_tab, settings_tab = st.tabs(
        ("New Crawl", "Runs", "Data Preview", "Analytics", "Logs", "Settings")
    )
    with new_tab:
        _render_new_crawl(repo)
    with runs_tab:
        _render_runs(repo)
    with preview_tab:
        _render_data_preview(repo)
    with analytics_tab:
        _render_analytics(repo)
    with logs_tab:
        _render_logs(repo)
    with settings_tab:
        _render_settings()


if __name__ == "__main__":
    main()
