"""OpenAI Responses API analysis for scam evidence and grounded insights."""

from __future__ import annotations

import asyncio
import copy
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, Optional

import httpx

from .normalization import (
    VALID_CATEGORIES,
    VALID_INDICATOR_TYPES,
    normalize_classification,
)


OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
DEFAULT_PROMPT_VERSION = "scamdna-openai-v1"
RETRYABLE_STATUS_CODES = frozenset({408, 409, 425, 429})
VALID_REASONING_EFFORTS = frozenset({"none", "low"})


_INDICATOR_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "type": {"type": "string", "enum": sorted(VALID_INDICATOR_TYPES)},
        "value": {"type": "string"},
        "normalized_value": {"type": "string"},
        "evidence_source": {
            "type": "string",
            "enum": [
                "post_text",
                "comment",
                "image",
                "qr",
                "search_snippet",
                "metadata",
            ],
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": [
        "type",
        "value",
        "normalized_value",
        "evidence_source",
        "confidence",
    ],
}

_EVIDENCE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "source": {
            "type": "string",
            "enum": [
                "post_text",
                "comment",
                "image",
                "qr",
                "search_snippet",
                "metadata",
            ],
        },
        "claim": {"type": "string"},
        "excerpt": {"type": "string"},
    },
    "required": ["source", "claim", "excerpt"],
}

_MEDIA_FINDING_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "image_url": {"type": "string"},
        "description": {"type": "string"},
        "visible_text": {"type": "string"},
        "qr_present": {"type": "boolean"},
        "qr_payload": {"type": "string"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": [
        "image_url",
        "description",
        "visible_text",
        "qr_present",
        "qr_payload",
        "confidence",
    ],
}

ITEM_ANALYSIS_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "primary_category": {"type": "string", "enum": sorted(VALID_CATEGORIES)},
        "scam_types": {"type": "array", "items": {"type": "string"}},
        "bank_roles": {"type": "array", "items": {"type": "string"}},
        "specific_case": {"type": "boolean"},
        "first_person_report": {"type": "boolean"},
        "summary": {"type": "string"},
        "severity": {"type": "integer", "minimum": 1, "maximum": 5},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "indicators": {"type": "array", "items": _INDICATOR_SCHEMA},
        "evidence": {"type": "array", "items": _EVIDENCE_SCHEMA},
        "media_findings": {"type": "array", "items": _MEDIA_FINDING_SCHEMA},
    },
    "required": [
        "primary_category",
        "scam_types",
        "bank_roles",
        "specific_case",
        "first_person_report",
        "summary",
        "severity",
        "confidence",
        "indicators",
        "evidence",
        "media_findings",
    ],
}

INSIGHT_SUMMARY_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "overview": {"type": "string"},
        "insights": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "severity": {"type": "integer", "minimum": 1, "maximum": 5},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence_document_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "evidence_links": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": [
                    "title",
                    "summary",
                    "severity",
                    "confidence",
                    "evidence_document_ids",
                    "evidence_links",
                ],
            },
        },
    },
    "required": ["overview", "insights"],
}


ITEM_SYSTEM_PROMPT = """You analyze public web evidence for a bank-side scam intelligence dataset.
Return only the requested structured object. Ground every claim in the supplied text,
metadata, or images. Never invent an account number, phone number, identity, loss,
bank role, or QR payload. If a QR is present but unreadable, set qr_payload to an empty
string. Classify service complaints as customer_feedback, legitimate reporting or PR as
news_pr, unrelated content as noise, specific scam incidents as scam_report, and fake
bank/person/brand behavior as impersonation_abuse. Write concise Vietnamese summaries.
Evidence excerpts must be short and verbatim. Empty arrays are valid."""

INSIGHT_SYSTEM_PROMPT = """You summarize already-computed scam metrics, clusters, and
anomalies. Return only the requested structured object. Every insight must cite document
IDs and source links present in the supplied context. Do not create links, entities,
relationships, campaign claims, or counts that are not supported by that context. Write
concise Vietnamese summaries. Prefer a small number of strong insights over weak ones."""


class OpenAIAnalysisError(RuntimeError):
    """OpenAI transport, HTTP, or response-contract failure."""

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


class OpenAIResponseError(OpenAIAnalysisError):
    """The API returned success but no usable structured output."""


@dataclass(frozen=True)
class OpenAIAnalysisResult:
    """Normalized item analysis plus provider audit and usage data."""

    classification: Dict[str, Any]
    model: str
    response_id: str
    usage: Dict[str, Any]
    raw_response: Dict[str, Any]
    prompt_version: str = DEFAULT_PROMPT_VERSION
    vision_fallback_reason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "classification": self.classification,
            "model": self.model,
            "response_id": self.response_id,
            "usage": self.usage,
            "raw_response": self.raw_response,
            "prompt_version": self.prompt_version,
            "vision_fallback_reason": self.vision_fallback_reason,
        }


@dataclass(frozen=True)
class OpenAIInsightResult:
    """Grounded aggregate insight summary plus provider audit and usage data."""

    summary: Dict[str, Any]
    model: str
    response_id: str
    usage: Dict[str, Any]
    raw_response: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "summary": self.summary,
            "model": self.model,
            "response_id": self.response_id,
            "usage": self.usage,
            "raw_response": self.raw_response,
        }


class OpenAIAnalysisClient:
    """Minimal async client for structured Responses API analysis."""

    def __init__(
        self,
        api_key: str,
        *,
        client: Optional[httpx.AsyncClient] = None,
        model: str = DEFAULT_OPENAI_MODEL,
        reasoning_effort: str = "none",
        max_image_urls: int = 3,
        max_retries: int = 3,
        backoff_base_seconds: float = 0.5,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if not api_key:
            raise ValueError("OpenAI API key is required")
        if not model:
            raise ValueError("OpenAI model is required")
        self._validate_reasoning_effort(reasoning_effort)
        if max_image_urls < 0:
            raise ValueError("max_image_urls cannot be negative")
        if max_retries < 0:
            raise ValueError("max_retries cannot be negative")

        self.api_key = api_key
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.max_image_urls = max_image_urls
        self.max_retries = max_retries
        self.backoff_base_seconds = max(0.0, backoff_base_seconds)
        self._sleep = sleep
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(90.0))

    async def __aenter__(self) -> "OpenAIAnalysisClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def replace_api_key(self, api_key: str) -> None:
        """Replace the key without rebuilding a long-lived worker client."""

        if not api_key:
            raise ValueError("OpenAI API key is required")
        self.api_key = api_key

    @staticmethod
    def _validate_reasoning_effort(value: str) -> None:
        if value not in VALID_REASONING_EFFORTS:
            raise ValueError("reasoning_effort must be 'none' or 'low'")

    @staticmethod
    def _response_payload(response: httpx.Response) -> Any:
        try:
            return response.json()
        except (TypeError, ValueError):
            return {"text": response.text[:2000]}

    @staticmethod
    def _is_retryable_status(status_code: int) -> bool:
        return status_code in RETRYABLE_STATUS_CODES or 500 <= status_code <= 599

    def _retry_delay(self, attempt: int, response: Optional[httpx.Response]) -> float:
        if response is not None:
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                try:
                    return max(0.0, float(retry_after))
                except ValueError:
                    pass
        return self.backoff_base_seconds * (2**attempt)

    @staticmethod
    def _error_message(status_code: int, payload: Any) -> str:
        message = "OpenAI HTTP %s" % status_code
        if isinstance(payload, Mapping):
            error = payload.get("error")
            if isinstance(error, Mapping):
                detail = error.get("message") or error.get("code") or error.get("type")
                if detail:
                    message += ": %s" % detail
            elif error:
                message += ": %s" % error
        return message

    async def _post_responses(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        headers = {
            "Authorization": "Bearer %s" % self.api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        for attempt in range(self.max_retries + 1):
            response: Optional[httpx.Response] = None
            try:
                response = await self._client.post(
                    OPENAI_RESPONSES_URL,
                    headers=headers,
                    json=dict(payload),
                )
            except (httpx.TimeoutException, httpx.TransportError) as error:
                if attempt >= self.max_retries:
                    raise OpenAIAnalysisError(
                        "OpenAI request failed: %s" % error,
                        retryable=True,
                    ) from error
            else:
                provider_payload = self._response_payload(response)
                if 200 <= response.status_code < 300:
                    if not isinstance(provider_payload, dict):
                        raise OpenAIResponseError(
                            "OpenAI returned a non-object JSON response",
                            status_code=response.status_code,
                            payload=provider_payload,
                        )
                    return provider_payload

                retryable = self._is_retryable_status(response.status_code)
                if not retryable or attempt >= self.max_retries:
                    raise OpenAIAnalysisError(
                        self._error_message(response.status_code, provider_payload),
                        status_code=response.status_code,
                        retryable=retryable,
                        payload=provider_payload,
                    )

            await self._sleep(self._retry_delay(attempt, response))

        raise OpenAIAnalysisError("OpenAI request failed", retryable=True)

    @staticmethod
    def _structured_format(name: str, schema: Mapping[str, Any]) -> Dict[str, Any]:
        return {
            "type": "json_schema",
            "name": name,
            "strict": True,
            "schema": copy.deepcopy(dict(schema)),
        }

    @staticmethod
    def _serialize_context(context: Mapping[str, Any]) -> str:
        return json.dumps(
            context,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )

    @staticmethod
    def _select_image_urls(image_urls: Optional[Iterable[str]], limit: int) -> List[str]:
        if limit == 0 or not image_urls:
            return []
        selected: List[str] = []
        seen = set()
        for value in image_urls:
            url = str(value).strip()
            if not url or url in seen:
                continue
            selected.append(url)
            seen.add(url)
            if len(selected) >= limit:
                break
        return selected

    @staticmethod
    def _extract_output_object(response: Mapping[str, Any]) -> Dict[str, Any]:
        text = response.get("output_text")
        refusal: Optional[str] = None
        if not isinstance(text, str) or not text.strip():
            for item in response.get("output") or []:
                if not isinstance(item, Mapping) or item.get("type") != "message":
                    continue
                for content in item.get("content") or []:
                    if not isinstance(content, Mapping):
                        continue
                    if content.get("type") == "output_text" and content.get("text"):
                        text = str(content["text"])
                        break
                    if content.get("type") == "refusal" and content.get("refusal"):
                        refusal = str(content["refusal"])
                if isinstance(text, str) and text.strip():
                    break

        if not isinstance(text, str) or not text.strip():
            detail = ": %s" % refusal if refusal else ""
            raise OpenAIResponseError(
                "OpenAI response contained no structured output%s" % detail,
                payload=dict(response),
            )
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError) as error:
            raise OpenAIResponseError(
                "OpenAI returned invalid structured JSON: %s" % error,
                payload=dict(response),
            ) from error
        if not isinstance(parsed, dict):
            raise OpenAIResponseError(
                "OpenAI structured output is not an object",
                payload=dict(response),
            )
        return parsed

    def _base_payload(
        self,
        *,
        model: str,
        reasoning_effort: str,
        system_prompt: str,
        user_content: Any,
        schema_name: str,
        schema: Mapping[str, Any],
        max_output_tokens: int,
    ) -> Dict[str, Any]:
        return {
            "model": model,
            "reasoning": {"effort": reasoning_effort},
            "input": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "text": {"format": self._structured_format(schema_name, schema)},
            "max_output_tokens": max_output_tokens,
            "store": False,
        }

    async def classify(
        self,
        evidence_bundle: Mapping[str, Any],
        *,
        image_urls: Optional[Iterable[str]] = None,
        max_image_urls: Optional[int] = None,
        model: Optional[str] = None,
        reasoning_effort: Optional[str] = None,
        prompt_version: str = DEFAULT_PROMPT_VERSION,
        max_output_tokens: int = 4000,
    ) -> OpenAIAnalysisResult:
        """Analyze one evidence bundle, optionally including a bounded set of images."""

        if not isinstance(evidence_bundle, Mapping) or not evidence_bundle:
            raise ValueError("evidence_bundle must be a non-empty mapping")
        if max_output_tokens < 256:
            raise ValueError("max_output_tokens must be at least 256")
        selected_model = model or self.model
        effort = reasoning_effort or self.reasoning_effort
        self._validate_reasoning_effort(effort)
        image_limit = self.max_image_urls if max_image_urls is None else max_image_urls
        if image_limit < 0:
            raise ValueError("max_image_urls cannot be negative")
        selected_images = self._select_image_urls(image_urls, image_limit)

        text_input = "Evidence bundle:\n" + self._serialize_context(evidence_bundle)
        content: List[Dict[str, Any]] = [{"type": "input_text", "text": text_input}]
        content.extend(
            {
                "type": "input_image",
                "image_url": image_url,
                "detail": "high",
            }
            for image_url in selected_images
        )
        payload = self._base_payload(
            model=selected_model,
            reasoning_effort=effort,
            system_prompt=ITEM_SYSTEM_PROMPT,
            user_content=content,
            schema_name="scamdna_item_analysis",
            schema=ITEM_ANALYSIS_SCHEMA,
            max_output_tokens=max_output_tokens,
        )

        vision_fallback_reason: Optional[str] = None
        try:
            response = await self._post_responses(payload)
        except OpenAIAnalysisError as error:
            if not selected_images or error.status_code != 400 or error.retryable:
                raise
            vision_fallback_reason = str(error)
            text_only_payload = copy.deepcopy(payload)
            text_only_payload["input"][1]["content"] = [content[0]]
            response = await self._post_responses(text_only_payload)

        raw_classification = self._extract_output_object(response)
        normalized = normalize_classification(raw_classification)
        normalized["evidence"] = copy.deepcopy(raw_classification.get("evidence") or [])
        normalized["media_findings"] = copy.deepcopy(
            raw_classification.get("media_findings") or []
        )
        return OpenAIAnalysisResult(
            classification=normalized,
            model=str(response.get("model") or selected_model),
            response_id=str(response.get("id") or ""),
            usage=dict(response.get("usage") or {}),
            raw_response=response,
            prompt_version=prompt_version,
            vision_fallback_reason=vision_fallback_reason,
        )

    async def analyze_item(
        self,
        evidence_bundle: Mapping[str, Any],
        **kwargs: Any,
    ) -> OpenAIAnalysisResult:
        """Descriptive alias for :meth:`classify`."""

        return await self.classify(evidence_bundle, **kwargs)

    async def summarize_insights(
        self,
        context: Mapping[str, Any],
        *,
        model: Optional[str] = None,
        reasoning_effort: Optional[str] = None,
        max_output_tokens: int = 2400,
    ) -> OpenAIInsightResult:
        """Create grounded summaries from SQL metrics, clusters, and anomalies."""

        if not isinstance(context, Mapping) or not context:
            raise ValueError("context must be a non-empty mapping")
        if max_output_tokens < 256:
            raise ValueError("max_output_tokens must be at least 256")
        selected_model = model or self.model
        effort = reasoning_effort or self.reasoning_effort
        self._validate_reasoning_effort(effort)
        payload = self._base_payload(
            model=selected_model,
            reasoning_effort=effort,
            system_prompt=INSIGHT_SYSTEM_PROMPT,
            user_content="Analysis context:\n" + self._serialize_context(context),
            schema_name="scamdna_insight_summary",
            schema=INSIGHT_SUMMARY_SCHEMA,
            max_output_tokens=max_output_tokens,
        )
        response = await self._post_responses(payload)
        summary = self._extract_output_object(response)
        return OpenAIInsightResult(
            summary=summary,
            model=str(response.get("model") or selected_model),
            response_id=str(response.get("id") or ""),
            usage=dict(response.get("usage") or {}),
            raw_response=response,
        )
