"""Async TinyFish Search, Fetch, and Agent REST client.

The client deliberately returns TinyFish's JSON shapes with minimal wrapping so
the worker can persist provider evidence verbatim. Supplying an ``httpx``
client, sleep function, and clock keeps every network and polling path easy to
unit test.
"""

from __future__ import annotations

import asyncio
import time
from copy import deepcopy
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, Sequence

import httpx


SEARCH_URL = "https://api.search.tinyfish.ai"
FETCH_URL = "https://api.fetch.tinyfish.ai"
AGENT_BASE_URL = "https://agent.tinyfish.ai"
AGENT_ASYNC_URL = AGENT_BASE_URL + "/v1/automation/run-async"
AGENT_MAX_DURATION_SECONDS = 180
TERMINAL_AGENT_STATUSES = frozenset({"COMPLETED", "FAILED", "CANCELLED"})
RETRYABLE_STATUS_CODES = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


DEFAULT_AGENT_OUTPUT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "post_text": {"type": "string"},
        "author_display_name": {"type": "string"},
        "published_at": {"type": "string"},
        "comments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "author_display_name": {"type": "string"},
                    "body": {"type": "string"},
                    "published_at": {"type": "string"},
                    "source_url": {"type": "string"},
                    "external_id": {"type": "string"},
                },
                "required": [
                    "author_display_name",
                    "body",
                    "published_at",
                    "source_url",
                    "external_id",
                ],
            },
        },
        "media": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "source_url": {"type": "string"},
                    "media_type": {"type": "string"},
                    "visual_description": {"type": "string"},
                    "content_hash": {"type": "string"},
                    "qr_present": {"type": "boolean"},
                    "qr_payload": {"type": "string"},
                    "qr_confidence": {"type": "number"},
                },
                "required": [
                    "source_url",
                    "media_type",
                    "visual_description",
                    "content_hash",
                    "qr_present",
                    "qr_payload",
                    "qr_confidence",
                ],
            },
        },
    },
    "required": [
        "post_text",
        "author_display_name",
        "published_at",
        "comments",
        "media",
    ],
}


def build_agent_goal(comment_limit: int = 10) -> str:
    if comment_limit < 0:
        raise ValueError("comment_limit cannot be negative")
    return (
        "Inspect this public post/page as fraud evidence for a bank analyst. "
        "Extract the full visible post text, author, and publication time. "
        "Read at most %d useful visible comments/replies, prioritizing comments "
        "that report losses, payment details, identities, contact details, links, "
        "or corroborating evidence. Inspect every visible image and screenshot, "
        "including transaction receipts and QR codes. For each media item return "
        "its URL when available, media_type (image, screenshot, qr_code, or other), "
        "a factual visual description, and QR evidence. Never guess or invent a QR "
        "payload: if it is not clearly readable, set qr_present=true, qr_payload to "
        "an empty string, and qr_confidence=0. Use empty strings for unavailable "
        "fields and return only data visible on this page. Return ONLY valid JSON "
        "with keys post_text, author_display_name, published_at, comments, and media."
    ) % comment_limit


class TinyFishError(RuntimeError):
    """Base error carrying provider details and retryability."""

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


class TinyFishFetchError(TinyFishError):
    pass


class TinyFishAgentError(TinyFishError):
    pass


class TinyFishAgentTimeout(TinyFishAgentError):
    pass


class TinyFishClient:
    """Small async REST client around TinyFish's three pipeline APIs."""

    def __init__(
        self,
        api_key: str,
        *,
        client: Optional[httpx.AsyncClient] = None,
        max_retries: int = 3,
        backoff_base_seconds: float = 0.5,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not api_key:
            raise ValueError("TinyFish API key is required")
        if max_retries < 0:
            raise ValueError("max_retries cannot be negative")
        self.api_key = api_key
        self.max_retries = max_retries
        self.backoff_base_seconds = max(0.0, backoff_base_seconds)
        self._sleep = sleep
        self._clock = clock
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(150.0))

    async def __aenter__(self) -> "TinyFishClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    @property
    def headers(self) -> Dict[str, str]:
        return {"X-API-Key": self.api_key, "Accept": "application/json"}

    @staticmethod
    def _response_payload(response: httpx.Response) -> Any:
        try:
            return response.json()
        except (ValueError, TypeError):
            return {"text": response.text[:2000]}

    def _retry_delay(self, attempt: int, response: Optional[httpx.Response] = None) -> float:
        if response is not None:
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                try:
                    return max(0.0, float(retry_after))
                except ValueError:
                    pass
        return self.backoff_base_seconds * (2**attempt)

    async def _request_json(self, method: str, url: str, **kwargs: Any) -> Dict[str, Any]:
        last_error: Optional[BaseException] = None
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", {}) or {})
        for attempt in range(self.max_retries + 1):
            response: Optional[httpx.Response] = None
            try:
                response = await self._client.request(method, url, headers=headers, **kwargs)
            except (httpx.TimeoutException, httpx.TransportError) as error:
                last_error = error
                if attempt >= self.max_retries:
                    raise TinyFishError(
                        "TinyFish request failed: %s" % error,
                        retryable=True,
                    ) from error
            else:
                if 200 <= response.status_code < 300:
                    payload = self._response_payload(response)
                    if not isinstance(payload, dict):
                        raise TinyFishError(
                            "TinyFish returned a non-object JSON response",
                            status_code=response.status_code,
                            payload=payload,
                        )
                    return payload
                payload = self._response_payload(response)
                retryable = response.status_code in RETRYABLE_STATUS_CODES
                if not retryable or attempt >= self.max_retries:
                    message = "TinyFish HTTP %s" % response.status_code
                    if isinstance(payload, Mapping):
                        detail = payload.get("message") or payload.get("error") or payload.get("detail")
                        if detail:
                            message += ": %s" % detail
                    raise TinyFishError(
                        message,
                        status_code=response.status_code,
                        retryable=retryable,
                        payload=payload,
                    )
            await self._sleep(self._retry_delay(attempt, response))
        raise TinyFishError("TinyFish request failed: %s" % last_error, retryable=True)

    async def search(
        self,
        query: str,
        *,
        page: int = 0,
        location: Optional[str] = None,
        language: Optional[str] = None,
        purpose: Optional[str] = None,
        after_date: Optional[str] = None,
        before_date: Optional[str] = None,
        recency_minutes: Optional[int] = None,
        domain_type: str = "web",
    ) -> Dict[str, Any]:
        """Run one TinyFish Search request and return its raw JSON object."""

        if not query.strip():
            raise ValueError("query is required")
        if not 0 <= page <= 10:
            raise ValueError("page must be between 0 and 10")
        if recency_minutes is not None and (after_date or before_date):
            raise ValueError("recency_minutes cannot be combined with date bounds")
        if recency_minutes is not None and not 1 <= recency_minutes <= 5_256_000:
            raise ValueError("recency_minutes must be between 1 and 5256000")
        if domain_type not in {"web", "news", "research_paper"}:
            raise ValueError("invalid domain_type")
        if domain_type == "research_paper" and (after_date or before_date or recency_minutes):
            raise ValueError("research_paper search does not support date filters")

        params: Dict[str, Any] = {
            "query": query.strip(),
            "page": page,
            "domain_type": domain_type,
        }
        optional = {
            "location": location,
            "language": language,
            "purpose": purpose,
            "after_date": after_date,
            "before_date": before_date,
            "recency_minutes": recency_minutes,
        }
        params.update({key: value for key, value in optional.items() if value is not None})
        return await self._request_json("GET", SEARCH_URL, params=params)

    async def search_task(self, task: Any) -> Dict[str, Any]:
        """Search a ``SearchTask`` or any object exposing ``to_search_params``."""

        params = task.to_search_params() if hasattr(task, "to_search_params") else dict(task)
        return await self.search(**params)

    async def fetch_urls(
        self,
        urls: Sequence[str],
        *,
        output_format: str = "markdown",
        links: bool = True,
        image_links: bool = True,
        ttl: Optional[int] = 0,
        per_url_timeout_ms: int = 110_000,
        include_etag_and_last_modified: bool = True,
        if_none_match: Optional[str] = None,
        if_modified_since: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Fetch one batch (maximum 10 URLs), preserving per-URL errors."""

        clean_urls = [
            str(url).strip()
            for url in urls
            if url is not None and str(url).strip()
        ]
        if not clean_urls or len(clean_urls) > 10:
            raise ValueError("fetch_urls requires between 1 and 10 URLs")
        if output_format not in {"markdown", "html", "json"}:
            raise ValueError("output_format must be markdown, html, or json")
        if not 1 <= per_url_timeout_ms <= 110_000:
            raise ValueError("per_url_timeout_ms must be between 1 and 110000")
        if ttl is not None and ttl < 0:
            raise ValueError("ttl cannot be negative")
        if len(clean_urls) > 1 and (if_none_match or if_modified_since):
            raise ValueError("conditional Fetch fields can only be used with one URL")

        payload: Dict[str, Any] = {
            "urls": clean_urls,
            "format": output_format,
            "links": links,
            "image_links": image_links,
            "per_url_timeout_ms": per_url_timeout_ms,
            "include_etag_and_last_modified": include_etag_and_last_modified,
        }
        if ttl is not None:
            payload["ttl"] = ttl
        if if_none_match:
            payload["if_none_match"] = if_none_match
        if if_modified_since:
            payload["if_modified_since"] = if_modified_since
        return await self._request_json("POST", FETCH_URL, json=payload)

    async def fetch_url(self, url: str, **kwargs: Any) -> Dict[str, Any]:
        """Fetch one URL and raise a typed error for its per-URL failure."""

        payload = await self.fetch_urls([url], **kwargs)
        results = payload.get("results") or []
        if results:
            return dict(results[0])
        errors = payload.get("errors") or []
        provider_error = errors[0] if errors else {"error": "empty_response", "url": url}
        code = provider_error.get("error") if isinstance(provider_error, Mapping) else "fetch_failed"
        retryable = code in {"target_unreachable", "timeout", "bot_blocked", "proxy_error"}
        raise TinyFishFetchError(
            "TinyFish Fetch failed for %s: %s" % (url, code),
            retryable=retryable,
            payload=provider_error,
        )

    @staticmethod
    def should_deep_enrich(
        fetch_result: Mapping[str, Any],
        *,
        force: bool = False,
        min_text_characters: int = 400,
    ) -> bool:
        """Apply the hackathon Agent policy to one Fetch result."""

        if force:
            return True
        if min_text_characters < 0:
            raise ValueError("min_text_characters cannot be negative")
        if fetch_result.get("image_links"):
            return True
        text = fetch_result.get("text")
        if isinstance(text, Mapping):
            text = str(text)
        return len(str(text or "").strip()) < min_text_characters

    async def start_agent(
        self,
        url: str,
        *,
        goal: Optional[str] = None,
        comment_limit: int = 10,
        output_schema: Optional[Mapping[str, Any]] = None,
        max_duration_seconds: int = AGENT_MAX_DURATION_SECONDS,
        browser_profile: str = "lite",
    ) -> str:
        """Queue an Agent run and return its run ID immediately."""

        if not url.strip():
            raise ValueError("url is required")
        if not 1 <= max_duration_seconds <= AGENT_MAX_DURATION_SECONDS:
            raise ValueError("max_duration_seconds must be between 1 and 180")
        if browser_profile not in {"lite", "stealth"}:
            raise ValueError("browser_profile must be lite or stealth")
        payload: Dict[str, Any] = {
            "url": url.strip(),
            "goal": goal or build_agent_goal(comment_limit),
            "browser_profile": browser_profile,
            "agent_config": {"max_duration_seconds": max_duration_seconds},
        }
        # Structured output is account-gated in TinyFish. The goal already requests
        # strict JSON, so omit the schema unless the caller explicitly enables it.
        if output_schema is not None:
            payload["output_schema"] = deepcopy(dict(output_schema))
        response = await self._request_json("POST", AGENT_ASYNC_URL, json=payload)
        run_id = response.get("run_id")
        if not run_id:
            error = response.get("error") or "Agent did not return a run_id"
            raise TinyFishAgentError(str(error), payload=response)
        return str(run_id)

    async def get_agent_run(
        self,
        run_id: str,
        *,
        screenshots: str = "url",
        html: str = "none",
    ) -> Dict[str, Any]:
        if screenshots not in {"url", "base64", "none"}:
            raise ValueError("screenshots must be url, base64, or none")
        if html not in {"url", "none"}:
            raise ValueError("html must be url or none")
        return await self._request_json(
            "GET",
            "%s/v1/runs/%s" % (AGENT_BASE_URL, run_id),
            params={"screenshots": screenshots, "html": html},
        )

    async def cancel_agent_run(self, run_id: str) -> Dict[str, Any]:
        return await self._request_json(
            "POST",
            "%s/v1/runs/%s/cancel" % (AGENT_BASE_URL, run_id),
        )

    async def poll_agent_run(
        self,
        run_id: str,
        *,
        poll_interval_seconds: float = 2.0,
        timeout_seconds: float = AGENT_MAX_DURATION_SECONDS,
        screenshots: str = "url",
    ) -> Dict[str, Any]:
        """Poll a queued run to a terminal state and enforce a 180s ceiling."""

        if poll_interval_seconds < 0:
            raise ValueError("poll_interval_seconds cannot be negative")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        deadline = self._clock() + min(float(timeout_seconds), AGENT_MAX_DURATION_SECONDS)
        while True:
            remaining = deadline - self._clock()
            if remaining <= 0:
                await self._cancel_after_timeout(run_id)
                raise TinyFishAgentTimeout(
                    "Agent run %s exceeded the %ss limit" % (run_id, min(timeout_seconds, 180)),
                    retryable=True,
                )
            try:
                run = await asyncio.wait_for(
                    self.get_agent_run(run_id, screenshots=screenshots),
                    timeout=remaining,
                )
            except asyncio.TimeoutError as error:
                await self._cancel_after_timeout(run_id)
                raise TinyFishAgentTimeout(
                    "Agent run %s exceeded the %ss limit" % (run_id, min(timeout_seconds, 180)),
                    retryable=True,
                ) from error
            status = str(run.get("status") or "").upper()
            if status == "COMPLETED":
                result = run.get("result")
                if not result:
                    raise TinyFishAgentError("Agent completed without a result", payload=run)
                if isinstance(result, Mapping) and (
                    str(result.get("status") or "").lower() == "failure" or result.get("error")
                ):
                    reason = result.get("reason") or result.get("error") or "Agent goal failed"
                    raise TinyFishAgentError(str(reason), payload=run)
                return run
            if status in {"FAILED", "CANCELLED"}:
                error = run.get("error")
                if isinstance(error, Mapping):
                    message = error.get("message") or status
                    retryable = error.get("category") in {"SYSTEM_FAILURE", "UNKNOWN"}
                else:
                    message = error or status
                    retryable = status == "FAILED"
                raise TinyFishAgentError(str(message), retryable=retryable, payload=run)
            if status and status not in {"PENDING", "RUNNING"}:
                raise TinyFishAgentError("Unexpected Agent status: %s" % status, payload=run)

            remaining = deadline - self._clock()
            if remaining <= 0:
                await self._cancel_after_timeout(run_id)
                raise TinyFishAgentTimeout(
                    "Agent run %s exceeded the %ss limit" % (run_id, min(timeout_seconds, 180)),
                    retryable=True,
                    payload=run,
                )
            await self._sleep(min(poll_interval_seconds, remaining))

    async def _cancel_after_timeout(self, run_id: str) -> None:
        try:
            await asyncio.wait_for(self.cancel_agent_run(run_id), timeout=5.0)
        except (TinyFishError, asyncio.TimeoutError):
            pass

    async def run_agent(
        self,
        url: str,
        *,
        goal: Optional[str] = None,
        comment_limit: int = 10,
        output_schema: Optional[Mapping[str, Any]] = None,
        max_duration_seconds: int = AGENT_MAX_DURATION_SECONDS,
        poll_interval_seconds: float = 2.0,
        browser_profile: str = "lite",
        screenshots: str = "url",
    ) -> Dict[str, Any]:
        """Queue and poll one Agent enrichment run."""

        run_id = await self.start_agent(
            url,
            goal=goal,
            comment_limit=comment_limit,
            output_schema=output_schema,
            max_duration_seconds=max_duration_seconds,
            browser_profile=browser_profile,
        )
        return await self.poll_agent_run(
            run_id,
            poll_interval_seconds=poll_interval_seconds,
            timeout_seconds=max_duration_seconds,
            screenshots=screenshots,
        )
