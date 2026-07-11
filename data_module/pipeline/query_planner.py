"""Pure query planning for backfills and bounded continuous crawl cycles."""

from __future__ import annotations

import calendar
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

from .normalization import normalize_domain, stable_hash


DEFAULT_SCAM_INTENTS: Tuple[str, ...] = (
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

DEFAULT_DOMAINS: Tuple[str, ...] = (
    "facebook.com",
    "threads.net",
    "threads.com",
    "x.com",
    "twitter.com",
    "reddit.com",
    "tiktok.com",
    "instagram.com",
)

DateLike = Union[date, datetime, str]


def parse_date(value: DateLike) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _unique_text(values: Iterable[Any]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        text = str(value).strip()
        key = text.casefold()
        if text and key not in seen:
            seen.add(key)
            result.append(text)
    return result


@dataclass(frozen=True)
class DateWindow:
    """An inclusive Search API date window."""

    start: date
    end: date
    granularity: str = "month"

    def __post_init__(self) -> None:
        if self.start > self.end:
            raise ValueError("DateWindow.start must be on or before DateWindow.end")

    def to_search_params(self) -> Dict[str, str]:
        return {"after_date": self.start.isoformat(), "before_date": self.end.isoformat()}

    def to_dict(self) -> Dict[str, str]:
        return {
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "granularity": self.granularity,
        }


@dataclass(frozen=True)
class SearchTask:
    """One search-provider request with a stable idempotency key."""

    keyword: str
    intent: str
    domain: str
    page: int = 0
    window: Optional[DateWindow] = None
    recency_minutes: Optional[int] = None
    cycle_started_at: Optional[datetime] = None
    location: Optional[str] = "VN"
    language: Optional[str] = "vi"
    purpose: str = "Find public scam reports and fraud evidence for bank risk analysis"
    query_override: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.keyword.strip():
            raise ValueError("keyword is required")
        if not self.intent.strip():
            raise ValueError("intent is required")
        if not normalize_domain(self.domain):
            raise ValueError("domain is required")
        if self.query_override is not None and not self.query_override.strip():
            raise ValueError("query_override cannot be blank")
        if not 0 <= self.page <= 10:
            raise ValueError("Search page must be between 0 and 10")
        if self.window and self.recency_minutes is not None:
            raise ValueError("date windows and recency_minutes are mutually exclusive")
        if self.recency_minutes is not None and not 1 <= self.recency_minutes <= 5_256_000:
            raise ValueError("recency_minutes must be between 1 and 5256000")

    @property
    def query(self) -> str:
        if self.query_override:
            return self.query_override.strip()
        keyword = self.keyword.strip().replace('"', "")
        intent_terms = [
            term.strip().replace('"', "")
            for term in self.intent.split("|")
            if term.strip().replace('"', "")
        ]
        if len(intent_terms) == 1:
            intent_clause = '"%s"' % intent_terms[0]
        else:
            intent_clause = "(" + " OR ".join(
                '"%s"' % term for term in intent_terms
            ) + ")"
        return '"%s" %s site:%s' % (
            keyword,
            intent_clause,
            normalize_domain(self.domain),
        )

    @property
    def idempotency_key(self) -> str:
        return stable_hash(self.to_dict())

    def to_search_params(self) -> Dict[str, Any]:
        params: Dict[str, Any] = {
            "query": self.query,
            "page": self.page,
            "domain_type": "web",
        }
        if self.location:
            params["location"] = self.location
        if self.language:
            params["language"] = self.language
        if self.purpose:
            params["purpose"] = self.purpose
        if self.window:
            params.update(self.window.to_search_params())
        elif self.recency_minutes is not None:
            params["recency_minutes"] = self.recency_minutes
        return params

    def to_dict(self) -> Dict[str, Any]:
        return {
            "keyword": self.keyword.strip(),
            "intent": self.intent.strip(),
            "domain": normalize_domain(self.domain),
            "page": self.page,
            "window": self.window.to_dict() if self.window else None,
            "recency_minutes": self.recency_minutes,
            "cycle_started_at": self.cycle_started_at.isoformat()
            if self.cycle_started_at
            else None,
            "location": self.location,
            "language": self.language,
            "purpose": self.purpose,
            "query_override": self.query_override,
        }


def monthly_windows(start: DateLike, end: DateLike) -> List[DateWindow]:
    """Split an inclusive date range along calendar-month boundaries."""

    first = parse_date(start)
    last = parse_date(end)
    if first > last:
        raise ValueError("start must be on or before end")
    windows = []
    cursor = first
    while cursor <= last:
        month_end = date(cursor.year, cursor.month, calendar.monthrange(cursor.year, cursor.month)[1])
        window_end = min(month_end, last)
        windows.append(DateWindow(cursor, window_end, "month"))
        cursor = window_end + timedelta(days=1)
    return windows


def weekly_windows(window: DateWindow) -> List[DateWindow]:
    """Split a saturated window into inclusive seven-day chunks."""

    windows = []
    cursor = window.start
    while cursor <= window.end:
        window_end = min(cursor + timedelta(days=6), window.end)
        windows.append(DateWindow(cursor, window_end, "week"))
        cursor = window_end + timedelta(days=1)
    return windows


def _validate_page_count(max_pages: int) -> int:
    if max_pages < 1 or max_pages > 11:
        raise ValueError("max_pages must be between 1 and 11")
    return max_pages


def build_backfill_tasks(
    keywords: Sequence[str],
    domains: Sequence[str],
    start: DateLike,
    end: DateLike,
    *,
    intents: Sequence[str] = DEFAULT_SCAM_INTENTS,
    max_pages: int = 1,
    location: Optional[str] = "VN",
    language: Optional[str] = "vi",
    purpose: str = "Find public scam reports and fraud evidence for bank risk analysis",
) -> List[SearchTask]:
    """Create keyword × intent × domain × month × page tasks."""

    max_pages = _validate_page_count(max_pages)
    clean_keywords = _unique_text(keywords)
    clean_intents = _unique_text(intents)
    clean_domains = _unique_text(normalize_domain(item) for item in domains)
    if not clean_keywords:
        raise ValueError("at least one keyword is required")
    if not clean_intents:
        raise ValueError("at least one intent is required")
    if not clean_domains:
        raise ValueError("at least one valid domain is required")

    return [
        SearchTask(
            keyword=keyword,
            intent=intent,
            domain=domain,
            page=page,
            window=window,
            location=location,
            language=language,
            purpose=purpose,
        )
        for keyword in clean_keywords
        for intent in clean_intents
        for domain in clean_domains
        for window in monthly_windows(start, end)
        for page in range(max_pages)
    ]


def continuous_cycle_window(
    *,
    interval_minutes: int = 15,
    overlap_minutes: int = 5,
    now: Optional[datetime] = None,
) -> Tuple[datetime, datetime, int]:
    """Return a bounded monitoring cycle and its Search API recency value."""

    if interval_minutes < 1:
        raise ValueError("interval_minutes must be positive")
    if overlap_minutes < 0:
        raise ValueError("overlap_minutes cannot be negative")
    cycle_end = now or datetime.now(timezone.utc)
    if cycle_end.tzinfo is None:
        cycle_end = cycle_end.replace(tzinfo=timezone.utc)
    recency = interval_minutes + overlap_minutes
    if recency > 5_256_000:
        raise ValueError("interval_minutes + overlap_minutes exceeds TinyFish recency limit")
    cycle_start = cycle_end - timedelta(minutes=recency)
    return cycle_start, cycle_end, recency


def build_continuous_tasks(
    keywords: Sequence[str],
    domains: Sequence[str],
    *,
    intents: Sequence[str] = DEFAULT_SCAM_INTENTS,
    interval_minutes: int = 15,
    overlap_minutes: int = 5,
    max_pages: int = 1,
    location: Optional[str] = "VN",
    language: Optional[str] = "vi",
    purpose: str = "Find new public scam reports and fraud evidence for bank risk monitoring",
    now: Optional[datetime] = None,
) -> List[SearchTask]:
    """Create tasks for one bounded continuous-monitoring cycle."""

    max_pages = _validate_page_count(max_pages)
    cycle_start, _, recency = continuous_cycle_window(
        interval_minutes=interval_minutes,
        overlap_minutes=overlap_minutes,
        now=now,
    )
    clean_keywords = _unique_text(keywords)
    clean_intents = _unique_text(intents)
    clean_domains = _unique_text(normalize_domain(item) for item in domains)
    if not clean_keywords or not clean_intents or not clean_domains:
        raise ValueError("keywords, intents, and valid domains are required")
    return [
        SearchTask(
            keyword=keyword,
            intent=intent,
            domain=domain,
            page=page,
            recency_minutes=recency,
            cycle_started_at=cycle_start,
            location=location,
            language=language,
            purpose=purpose,
        )
        for keyword in clean_keywords
        for intent in clean_intents
        for domain in clean_domains
        for page in range(max_pages)
    ]


def split_saturated_task(task: SearchTask, *, max_pages: int = 1) -> List[SearchTask]:
    """Replace a saturated monthly task with weekly page tasks."""

    max_pages = _validate_page_count(max_pages)
    if task.window is None:
        raise ValueError("only date-window tasks can be split")
    return [
        replace(task, window=week, page=page)
        for week in weekly_windows(task.window)
        for page in range(max_pages)
    ]
