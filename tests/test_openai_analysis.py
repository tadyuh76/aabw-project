import asyncio
import json

import httpx

from data_module.pipeline.openai_analysis import (
    DEFAULT_OPENAI_MODEL,
    OpenAIAnalysisClient,
)


def _item_output(**overrides):
    payload = {
        "primary_category": "scam_report",
        "scam_types": ["transfer_fraud"],
        "bank_roles": ["recipient_account_provider"],
        "specific_case": True,
        "first_person_report": True,
        "summary": "Nạn nhân báo cáo chuyển tiền cho kẻ lừa đảo.",
        "severity": 4,
        "confidence": 0.93,
        "indicators": [
            {
                "type": "phone",
                "value": "+84 912 345 678",
                "normalized_value": "+84 912 345 678",
                "evidence_source": "post_text",
                "confidence": 0.98,
            }
        ],
        "evidence": [
            {
                "source": "post_text",
                "claim": "Nạn nhân đã chuyển tiền.",
                "excerpt": "tôi đã chuyển tiền",
            }
        ],
        "media_findings": [],
    }
    payload.update(overrides)
    return payload


def _response(output, *, response_id="resp_1", model="gpt-5.6-luna"):
    return {
        "id": response_id,
        "model": model,
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(output)}],
            }
        ],
        "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30},
    }


def test_text_analysis_uses_responses_strict_schema_and_normalizes():
    requests = []

    async def handler(request):
        requests.append(request)
        return httpx.Response(200, json=_response(_item_output()))

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        openai = OpenAIAnalysisClient("test-key", client=client, max_retries=0)
        result = await openai.classify({"post_text": "tôi đã chuyển tiền"})
        await client.aclose()
        return result

    result = asyncio.run(run())
    request = requests[0]
    body = json.loads(request.content)
    assert str(request.url) == "https://api.openai.com/v1/responses"
    assert request.headers["Authorization"] == "Bearer test-key"
    assert body["model"] == DEFAULT_OPENAI_MODEL
    assert body["reasoning"] == {"effort": "none"}
    assert body["text"]["format"]["type"] == "json_schema"
    assert body["text"]["format"]["strict"] is True
    assert body["text"]["format"]["schema"]["additionalProperties"] is False
    assert body["input"][1]["content"][0]["type"] == "input_text"
    assert len(body["input"][1]["content"]) == 1
    assert result.classification["primary_category"] == "scam_report"
    assert result.classification["indicators"][0]["normalized_value"] == "0912345678"
    assert result.classification["evidence"][0]["excerpt"] == "tôi đã chuyển tiền"
    assert result.response_id == "resp_1"
    assert result.usage["total_tokens"] == 30


def test_image_analysis_limits_urls_and_uses_high_detail():
    requests = []
    media_findings = [
        {
            "image_url": "https://img.example/one.jpg",
            "description": "Ảnh chụp giao dịch.",
            "visible_text": "Giao dịch thành công",
            "qr_present": False,
            "qr_payload": "",
            "confidence": 0.9,
        }
    ]

    async def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json=_response(_item_output(media_findings=media_findings)),
        )

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        openai = OpenAIAnalysisClient(
            "test-key",
            client=client,
            max_image_urls=2,
            max_retries=0,
            reasoning_effort="low",
        )
        result = await openai.analyze_item(
            {"post_text": "weak text"},
            image_urls=[
                "https://img.example/one.jpg",
                "https://img.example/two.jpg",
                "https://img.example/three.jpg",
            ],
        )
        await client.aclose()
        return result

    result = asyncio.run(run())
    body = json.loads(requests[0].content)
    images = [
        part for part in body["input"][1]["content"] if part["type"] == "input_image"
    ]
    assert body["reasoning"] == {"effort": "low"}
    assert [item["image_url"] for item in images] == [
        "https://img.example/one.jpg",
        "https://img.example/two.jpg",
    ]
    assert all(item["detail"] == "high" for item in images)
    assert result.classification["media_findings"] == media_findings
    assert result.vision_fallback_reason is None


def test_nontransient_image_400_falls_back_once_to_text_only():
    requests = []

    async def handler(request):
        requests.append(request)
        body = json.loads(request.content)
        has_image = any(
            part["type"] == "input_image" for part in body["input"][1]["content"]
        )
        if has_image:
            return httpx.Response(
                400,
                json={"error": {"message": "Could not download image"}},
            )
        return httpx.Response(200, json=_response(_item_output()))

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        openai = OpenAIAnalysisClient("test-key", client=client, max_retries=0)
        result = await openai.classify(
            {"post_text": "usable fallback text"},
            image_urls=["https://img.example/expired.jpg"],
        )
        await client.aclose()
        return result

    result = asyncio.run(run())
    first = json.loads(requests[0].content)
    second = json.loads(requests[1].content)
    assert len(requests) == 2
    assert len(first["input"][1]["content"]) == 2
    assert second["input"][1]["content"] == [first["input"][1]["content"][0]]
    assert result.vision_fallback_reason == "OpenAI HTTP 400: Could not download image"


def test_transient_responses_are_retried_with_retry_after():
    attempts = 0
    delays = []

    async def handler(request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                429,
                headers={"Retry-After": "0"},
                json={"error": {"message": "rate limited"}},
            )
        if attempts == 2:
            return httpx.Response(503, json={"error": {"message": "busy"}})
        return httpx.Response(200, json=_response(_item_output()))

    async def fake_sleep(delay):
        delays.append(delay)

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        openai = OpenAIAnalysisClient(
            "test-key",
            client=client,
            max_retries=2,
            backoff_base_seconds=0,
            sleep=fake_sleep,
        )
        result = await openai.classify({"post_text": "evidence"})
        await client.aclose()
        return result

    result = asyncio.run(run())
    assert attempts == 3
    assert delays == [0, 0]
    assert result.classification["severity"] == 4


def test_summarize_insights_uses_grounded_strict_schema():
    requests = []
    summary = {
        "overview": "Hai bài cùng chia sẻ một số điện thoại.",
        "insights": [
            {
                "title": "Indicator dùng lại",
                "summary": "Số điện thoại xuất hiện trong hai báo cáo.",
                "severity": 3,
                "confidence": 0.88,
                "evidence_document_ids": ["doc-1", "doc-2"],
                "evidence_links": [
                    "https://example.com/1",
                    "https://example.com/2",
                ],
            }
        ],
    }

    async def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json=_response(summary, response_id="resp_summary"),
        )

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        openai = OpenAIAnalysisClient("test-key", client=client, max_retries=0)
        result = await openai.summarize_insights(
            {
                "clusters": [
                    {
                        "indicator": "0912345678",
                        "document_ids": ["doc-1", "doc-2"],
                        "links": ["https://example.com/1", "https://example.com/2"],
                    }
                ]
            }
        )
        await client.aclose()
        return result

    result = asyncio.run(run())
    body = json.loads(requests[0].content)
    schema_format = body["text"]["format"]
    assert schema_format["name"] == "scamdna_insight_summary"
    assert schema_format["strict"] is True
    assert schema_format["schema"]["required"] == ["overview", "insights"]
    assert result.summary == summary
    assert result.response_id == "resp_summary"
