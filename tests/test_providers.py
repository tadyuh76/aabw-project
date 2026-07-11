import asyncio
import json

import httpx

from data_module.pipeline import GroqClient, TinyFishClient


def test_tinyfish_search_and_fetch_use_expected_contracts():
    requests = []

    async def handler(request):
        requests.append(request)
        if request.url.host == "api.search.tinyfish.ai":
            return httpx.Response(
                200,
                json={"results": [{"url": "https://example.com/post"}]},
            )
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "url": "https://example.com/post",
                        "text": "evidence",
                        "image_links": [],
                    }
                ],
                "errors": [],
            },
        )

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        tinyfish = TinyFishClient("tiny", client=client, max_retries=0)
        search = await tinyfish.search(
            '"MB Bank" site:facebook.com',
            page=0,
            location="VN",
            language="vi",
            after_date="2026-07-01",
            before_date="2026-07-11",
        )
        fetched = await tinyfish.fetch_url(search["results"][0]["url"])
        await client.aclose()
        return fetched

    fetched = asyncio.run(run())
    assert fetched["text"] == "evidence"
    assert requests[0].headers["x-api-key"] == "tiny"
    fetch_body = json.loads(requests[1].content)
    assert fetch_body["image_links"] is True
    assert fetch_body["urls"] == ["https://example.com/post"]


def test_groq_json_response_is_normalized():
    async def handler(request):
        return httpx.Response(
            200,
            json={
                "model": "demo-model",
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "primary_category": "scam_report",
                                    "specific_case": True,
                                    "first_person_report": True,
                                    "summary": "A specific transfer scam",
                                    "severity": 3,
                                    "confidence": 0.9,
                                    "scam_types": ["transfer_fraud"],
                                    "bank_roles": ["payment_rail"],
                                    "indicators": [],
                                }
                            )
                        }
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        groq = GroqClient("groq", client=client, model="demo-model", max_retries=0)
        result = await groq.classify({"post_text": "I lost money"})
        await client.aclose()
        return result

    result = asyncio.run(run())
    assert result.classification["primary_category"] == "scam_report"
    assert result.classification["severity"] == 3
    assert result.usage["prompt_tokens"] == 10


def test_groq_retries_provider_json_validation_failure():
    attempts = 0

    async def handler(request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                400,
                json={
                    "error": {
                        "message": "Failed to validate JSON. Please adjust your prompt.",
                        "failed_generation": "{invalid json}",
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "model": "demo-model",
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "primary_category": "noise",
                                    "summary": "No usable scam evidence",
                                    "severity": 1,
                                    "confidence": 0.7,
                                    "scam_types": [],
                                    "bank_roles": [],
                                    "specific_case": False,
                                    "first_person_report": False,
                                    "indicators": [],
                                }
                            )
                        }
                    }
                ],
                "usage": {},
            },
        )

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        groq = GroqClient(
            "groq",
            client=client,
            model="demo-model",
            max_retries=1,
            backoff_base_seconds=0,
        )
        result = await groq.classify({"post_text": "weak evidence"})
        await client.aclose()
        return result

    result = asyncio.run(run())
    assert attempts == 2
    assert result.classification["primary_category"] == "noise"
