"""Async Google discovery through SerpAPI.

The adapter intentionally exposes the same ``{"results": [...]}`` envelope
used by the existing TinyFish search path. This lets discovery providers be
swapped without changing document persistence or URL processing.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional
from urllib.parse import urlsplit

import httpx


SERPAPI_SEARCH_URL = "https://serpapi.com/search.json"
RETRYABLE_STATUS_CODES = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


class SerpAPIError(RuntimeError):
    """SerpAPI failure with enough metadata for worker retry decisions."""

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        retryable: bool = False,
        payload: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable
        self.payload = payload


def _parse_date(value: Optional[str], field: str) -> Optional[dt.date]:
    if value is None:
        return None
    try:
        return dt.date.fromisoformat(str(value))
    except ValueError as error:
        raise ValueError("%s must use YYYY-MM-DD" % field) from error


def _google_date(value: dt.date) -> str:
    return "%d/%d/%d" % (value.month, value.day, value.year)


def build_date_tbs(
    after_date: Optional[str] = None,
    before_date: Optional[str] = None,
) -> Optional[str]:
    """Build Google's custom-date ``tbs`` value from inclusive ISO bounds."""

    start = _parse_date(after_date, "after_date")
    end = _parse_date(before_date, "before_date")
    if start and end and start > end:
        raise ValueError("after_date must be on or before before_date")
    if not start and not end:
        return None
    components = ["cdr:1"]
    if start:
        components.append("cd_min:%s" % _google_date(start))
    if end:
        components.append("cd_max:%s" % _google_date(end))
    return ",".join(components)


class SerpAPIClient:
    """Small async client for normalized Google organic results."""

    def __init__(
        self,
        api_key: str,
        *,
        client: Optional[httpx.AsyncClient] = None,
        max_retries: int = 3,
        backoff_base_seconds: float = 0.5,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        default_gl: Optional[str] = None,
        default_hl: Optional[str] = None,
        default_location: Optional[str] = None,
    ) -> None:
        if not str(api_key).strip():
            raise ValueError("SerpAPI API key is required")
        if max_retries < 0:
            raise ValueError("max_retries cannot be negative")
        self.api_key = str(api_key).strip()
        self.max_retries = max_retries
        self.backoff_base_seconds = max(0.0, backoff_base_seconds)
        self._sleep = sleep
        self.default_gl = default_gl
        self.default_hl = default_hl
        self.default_location = default_location
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(45.0))

    async def __aenter__(self) -> "SerpAPIClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def replace_api_key(self, api_key: str) -> None:
        """Use a new key for subsequent calls without rebuilding the client."""

        if not str(api_key).strip():
            raise ValueError("SerpAPI API key is required")
        self.api_key = str(api_key).strip()

    @staticmethod
    def _response_payload(response: httpx.Response) -> Any:
        try:
            return response.json()
        except (ValueError, TypeError):
            return {"text": response.text[:2000]}

    def _retry_delay(self, attempt: int, response: Optional[httpx.Response]) -> float:
        if response is not None:
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                try:
                    return max(0.0, float(retry_after))
                except ValueError:
                    pass
        return self.backoff_base_seconds * (2**attempt)

    async def _request_json(self, params: Mapping[str, Any]) -> Dict[str, Any]:
        last_error: Optional[BaseException] = None
        for attempt in range(self.max_retries + 1):
            response: Optional[httpx.Response] = None
            try:
                response = await self._client.get(SERPAPI_SEARCH_URL, params=dict(params))
            except (httpx.TimeoutException, httpx.TransportError) as error:
                last_error = error
                if attempt >= self.max_retries:
                    raise SerpAPIError(
                        "SerpAPI request failed: %s" % error,
                        retryable=True,
                    ) from error
            else:
                payload = self._response_payload(response)
                if 200 <= response.status_code < 300:
                    if not isinstance(payload, dict):
                        raise SerpAPIError(
                            "SerpAPI returned a non-object JSON response",
                            status_code=response.status_code,
                            payload=payload,
                        )
                    provider_error = str(payload.get("error") or "")
                    if provider_error and (
                        "hasn't returned any results" in provider_error.casefold()
                        or "no results" in provider_error.casefold()
                    ):
                        payload.setdefault("organic_results", [])
                        return payload
                    if provider_error:
                        raise SerpAPIError(
                            "SerpAPI error: %s" % provider_error,
                            status_code=response.status_code,
                            payload=payload,
                        )
                    return payload

                retryable = response.status_code in RETRYABLE_STATUS_CODES
                if not retryable or attempt >= self.max_retries:
                    detail = payload.get("error") if isinstance(payload, Mapping) else None
                    message = "SerpAPI HTTP %s" % response.status_code
                    if detail:
                        message += ": %s" % detail
                    raise SerpAPIError(
                        message,
                        status_code=response.status_code,
                        retryable=retryable,
                        payload=payload,
                    )
            await self._sleep(self._retry_delay(attempt, response))

        raise SerpAPIError("SerpAPI request failed: %s" % last_error, retryable=True)

    @staticmethod
    def _site_name(result: Mapping[str, Any], url: str) -> str:
        source = result.get("source")
        if isinstance(source, Mapping):
            source = source.get("name") or source.get("title")
        if source:
            return str(source).strip()
        host = (urlsplit(url).hostname or "").lower()
        return host[4:] if host.startswith("www.") else host

    @classmethod
    def _normalize_results(cls, payload: Mapping[str, Any], start: int) -> list:
        normalized = []
        for index, raw in enumerate(payload.get("organic_results") or []):
            if not isinstance(raw, Mapping):
                continue
            url = str(raw.get("link") or "").strip()
            if not url:
                continue
            position = raw.get("position")
            if not isinstance(position, int):
                position = start + index + 1
            normalized.append(
                {
                    "position": position,
                    "title": str(raw.get("title") or "").strip(),
                    "snippet": str(raw.get("snippet") or "").strip(),
                    "url": url,
                    "site_name": cls._site_name(raw, url),
                    "date": raw.get("date"),
                }
            )
        return normalized

    async def search(
        self,
        query: str,
        *,
        page: int = 0,
        start: Optional[int] = None,
        num: int = 10,
        gl: Optional[str] = None,
        hl: Optional[str] = None,
        location: Optional[str] = None,
        language: Optional[str] = None,
        after_date: Optional[str] = None,
        before_date: Optional[str] = None,
        recency_minutes: Optional[int] = None,
        purpose: Optional[str] = None,
        domain_type: str = "web",
    ) -> Dict[str, Any]:
        """Search Google and return TinyFish-compatible normalized results.

        ``purpose`` is accepted for compatibility with ``SearchTask`` but is
        intentionally not sent to Google. A two-letter ``location`` such as
        ``VN`` is treated as ``gl=vn``; longer values are passed as SerpAPI's
        geographic location string.
        """

        del purpose
        if not str(query).strip():
            raise ValueError("query is required")
        if domain_type != "web":
            raise ValueError("SerpAPI discovery currently supports domain_type=web only")
        if page < 0:
            raise ValueError("page cannot be negative")
        if start is not None and start < 0:
            raise ValueError("start cannot be negative")
        if not 1 <= num <= 100:
            raise ValueError("num must be between 1 and 100")
        if recency_minutes is not None and (after_date or before_date):
            raise ValueError("recency_minutes cannot be combined with date bounds")
        if recency_minutes is not None and recency_minutes < 1:
            raise ValueError("recency_minutes must be positive")

        offset = start if start is not None else page * num
        effective_gl = gl or self.default_gl
        effective_hl = hl or language or self.default_hl
        effective_location = location or self.default_location
        if effective_location and len(effective_location.strip()) == 2:
            effective_gl = effective_gl or effective_location.lower()
            effective_location = None

        params: Dict[str, Any] = {
            "engine": "google",
            "q": str(query).strip(),
            "api_key": self.api_key,
            "start": offset,
            "num": num,
        }
        optional = {
            "gl": effective_gl.lower() if effective_gl else None,
            "hl": effective_hl.lower() if effective_hl else None,
            "location": effective_location,
        }
        params.update({key: value for key, value in optional.items() if value})

        date_tbs = build_date_tbs(after_date, before_date)
        if date_tbs:
            params["tbs"] = date_tbs
        elif recency_minutes is not None:
            params["tbs"] = "qdr:n%d" % recency_minutes

        raw = await self._request_json(params)
        return {
            "results": self._normalize_results(raw, offset),
            "search_metadata": raw.get("search_metadata") or {},
            "search_information": raw.get("search_information") or {},
            "pagination": raw.get("serpapi_pagination") or {},
        }

    async def search_task(self, task: Any) -> Dict[str, Any]:
        """Search a ``SearchTask`` or mapping using the shared task contract."""

        params = task.to_search_params() if hasattr(task, "to_search_params") else dict(task)
        payload = await self.search(**params)
        domain = getattr(task, "domain", None)
        if domain is None and isinstance(task, Mapping):
            domain = task.get("domain")
        clean_domain = str(domain or "").strip().lower().removeprefix("www.")
        if clean_domain:
            payload["results"] = [
                result
                for result in payload.get("results") or []
                if (
                    (urlsplit(str(result.get("url") or "")).hostname or "")
                    .lower()
                    .removeprefix("www.")
                    == clean_domain
                    or (
                        (urlsplit(str(result.get("url") or "")).hostname or "")
                        .lower()
                        .removeprefix("www.")
                        .endswith("." + clean_domain)
                    )
                )
            ]
        return payload
