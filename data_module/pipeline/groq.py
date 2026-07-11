"""Groq JSON-mode classification and indicator extraction."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional

import httpx

from .normalization import (
    VALID_CATEGORIES,
    VALID_INDICATOR_TYPES,
    normalize_classification,
)


GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b"
DEFAULT_PROMPT_VERSION = "scamdna-v1"
RETRYABLE_STATUS_CODES = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


CLASSIFICATION_CONTRACT: Dict[str, Any] = {
    "primary_category": "one of: " + ", ".join(sorted(VALID_CATEGORIES)),
    "scam_types": ["short snake_case scam subtype"],
    "bank_roles": ["short snake_case role played by a bank in the reported event"],
    "specific_case": "boolean",
    "first_person_report": "boolean",
    "summary": "concise Vietnamese summary grounded only in supplied evidence",
    "severity": "integer from 1 (low) to 5 (critical)",
    "confidence": "number from 0 to 1",
    "indicators": [
        {
            "type": "one of: " + ", ".join(sorted(VALID_INDICATOR_TYPES)),
            "value": "exact display value from evidence",
            "normalized_value": "normalized value, or repeat value when unsure",
            "evidence_source": "post_text, comment, image, qr, search_snippet, or metadata",
            "confidence": "number from 0 to 1",
        }
    ],
}

SYSTEM_PROMPT = """You classify public web evidence for a bank fraud-analysis dataset.
Return exactly one JSON object and no prose. Use only supplied evidence; never infer an
account number, phone, identity, QR payload, loss, or bank role that is not visible.
Classify ordinary complaints as customer_feedback, legitimate reporting/PR as news_pr,
irrelevant material as noise, first-hand or corroborated scam incidents as scam_report,
and fake-bank/person/brand behavior as impersonation_abuse. Extract graph indicators
verbatim and provide a normalized form. Empty arrays are valid. All contract keys are
required. Severity must be 1..5 and confidence 0..1.

JSON contract:
{contract}
""".format(contract=json.dumps(CLASSIFICATION_CONTRACT, ensure_ascii=False, indent=2))


class GroqError(RuntimeError):
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


class GroqClassificationError(GroqError):
    pass


@dataclass(frozen=True)
class GroqResult:
    """Normalized classification plus provider data needed for usage/audit rows."""

    classification: Dict[str, Any]
    model: str
    prompt_version: str
    usage: Dict[str, Any]
    raw_response: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "classification": self.classification,
            "model": self.model,
            "prompt_version": self.prompt_version,
            "usage": self.usage,
            "raw_response": self.raw_response,
        }


class GroqClient:
    """Async Groq Chat Completions client using broadly supported JSON mode."""

    def __init__(
        self,
        api_key: str,
        *,
        client: Optional[httpx.AsyncClient] = None,
        model: str = DEFAULT_GROQ_MODEL,
        max_retries: int = 3,
        backoff_base_seconds: float = 0.5,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if not api_key:
            raise ValueError("Groq API key is required")
        if not model:
            raise ValueError("Groq model is required")
        if max_retries < 0:
            raise ValueError("max_retries cannot be negative")
        self.api_key = api_key
        self.model = model
        self.max_retries = max_retries
        self.backoff_base_seconds = max(0.0, backoff_base_seconds)
        self._sleep = sleep
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(90.0))

    async def __aenter__(self) -> "GroqClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    @staticmethod
    def _response_payload(response: httpx.Response) -> Any:
        try:
            return response.json()
        except (ValueError, TypeError):
            return {"text": response.text[:2000]}

    @staticmethod
    def _is_json_validation_failure(status_code: int, payload: Any) -> bool:
        """Groq can return a retryable 400 when JSON mode output is malformed."""

        if status_code != 400 or not isinstance(payload, Mapping):
            return False
        error = payload.get("error")
        try:
            text = json.dumps(error, ensure_ascii=False, default=str).lower()
        except (TypeError, ValueError):
            text = str(error).lower()
        return "failed to validate json" in text or (
            "failed_generation" in text and "json" in text
        )

    def _retry_delay(self, attempt: int, response: Optional[httpx.Response]) -> float:
        if response is not None:
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                try:
                    return max(0.0, float(retry_after))
                except ValueError:
                    pass
        return self.backoff_base_seconds * (2**attempt)

    async def _post_chat(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        headers = {
            "Authorization": "Bearer %s" % self.api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        for attempt in range(self.max_retries + 1):
            response: Optional[httpx.Response] = None
            try:
                response = await self._client.post(
                    GROQ_CHAT_COMPLETIONS_URL,
                    headers=headers,
                    json=dict(payload),
                )
            except (httpx.TimeoutException, httpx.TransportError) as error:
                if attempt >= self.max_retries:
                    raise GroqError("Groq request failed: %s" % error, retryable=True) from error
            else:
                provider_payload = self._response_payload(response)
                if 200 <= response.status_code < 300:
                    if not isinstance(provider_payload, dict):
                        raise GroqError(
                            "Groq returned a non-object JSON response",
                            status_code=response.status_code,
                            payload=provider_payload,
                        )
                    return provider_payload
                retryable = (
                    response.status_code in RETRYABLE_STATUS_CODES
                    or self._is_json_validation_failure(
                        response.status_code, provider_payload
                    )
                )
                if not retryable or attempt >= self.max_retries:
                    message = "Groq HTTP %s" % response.status_code
                    if isinstance(provider_payload, Mapping):
                        error = provider_payload.get("error")
                        if isinstance(error, Mapping):
                            message += ": %s" % (error.get("message") or error.get("code") or error)
                        elif error:
                            message += ": %s" % error
                    raise GroqError(
                        message,
                        status_code=response.status_code,
                        retryable=retryable,
                        payload=provider_payload,
                    )
            await self._sleep(self._retry_delay(attempt, response))
        raise GroqError("Groq request failed", retryable=True)

    async def classify(
        self,
        evidence_bundle: Mapping[str, Any],
        *,
        model: Optional[str] = None,
        prompt_version: str = DEFAULT_PROMPT_VERSION,
        max_completion_tokens: int = 1200,
    ) -> GroqResult:
        """Classify one evidence bundle and normalize its graph indicators."""

        if not isinstance(evidence_bundle, Mapping) or not evidence_bundle:
            raise ValueError("evidence_bundle must be a non-empty mapping")
        if max_completion_tokens < 256:
            raise ValueError("max_completion_tokens must be at least 256")
        selected_model = model or self.model
        user_content = json.dumps(
            evidence_bundle,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        response = await self._post_chat(
            {
                "model": selected_model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": "Evidence bundle:\n" + user_content},
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0,
                "max_completion_tokens": max_completion_tokens,
            }
        )
        try:
            content = response["choices"][0]["message"]["content"]
            if isinstance(content, Mapping):
                raw_classification = dict(content)
            else:
                raw_classification = json.loads(str(content))
            if not isinstance(raw_classification, dict):
                raise TypeError("classification content is not a JSON object")
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise GroqClassificationError(
                "Groq returned an invalid classification object: %s" % error,
                payload=response,
            ) from error

        return GroqResult(
            classification=normalize_classification(raw_classification),
            model=str(response.get("model") or selected_model),
            prompt_version=prompt_version,
            usage=dict(response.get("usage") or {}),
            raw_response=response,
        )
