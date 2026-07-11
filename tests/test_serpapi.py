import asyncio
from datetime import date

import httpx
import pytest

from data_module.pipeline.query_planner import DateWindow, SearchTask
from data_module.pipeline.serpapi import SerpAPIClient, SerpAPIError, build_date_tbs


def test_serpapi_search_maps_google_params_and_normalizes_results():
    requests = []

    async def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "search_metadata": {"id": "search-1", "status": "Success"},
                "organic_results": [
                    {
                        "position": 1,
                        "title": "Public scam warning",
                        "link": "https://www.facebook.com/groups/demo/posts/123",
                        "snippet": "MB Bank transfer scam evidence",
                        "source": "Facebook",
                        "date": "Jul 10, 2026",
                    },
                    {
                        "title": "Second warning",
                        "link": "https://www.reddit.com/r/scams/comments/abc",
                    },
                    {"title": "No fetchable link"},
                ],
                "search_information": {"total_results": 2},
                "serpapi_pagination": {"current": 3},
            },
        )

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        serpapi = SerpAPIClient("first-key", client=client, max_retries=0)
        result = await serpapi.search(
            '"MB Bank" "lừa đảo" site:facebook.com',
            page=2,
            num=10,
            gl="VN",
            hl="VI",
            location="Ho Chi Minh City, Vietnam",
            after_date="2026-07-01",
            before_date="2026-07-31",
        )
        await client.aclose()
        return result

    result = asyncio.run(run())
    params = requests[0].url.params
    assert params["engine"] == "google"
    assert params["q"] == '"MB Bank" "lừa đảo" site:facebook.com'
    assert params["api_key"] == "first-key"
    assert params["gl"] == "vn"
    assert params["hl"] == "vi"
    assert params["location"] == "Ho Chi Minh City, Vietnam"
    assert params["start"] == "20"
    assert params["num"] == "10"
    assert params["tbs"] == "cdr:1,cd_min:7/1/2026,cd_max:7/31/2026"
    assert result["results"] == [
        {
            "position": 1,
            "title": "Public scam warning",
            "snippet": "MB Bank transfer scam evidence",
            "url": "https://www.facebook.com/groups/demo/posts/123",
            "site_name": "Facebook",
            "date": "Jul 10, 2026",
        },
        {
            "position": 22,
            "title": "Second warning",
            "snippet": "",
            "url": "https://www.reddit.com/r/scams/comments/abc",
            "site_name": "reddit.com",
            "date": None,
        },
    ]
    assert result["pagination"] == {"current": 3}


def test_serpapi_search_task_accepts_existing_task_contract():
    captured = []

    async def handler(request):
        captured.append(request)
        return httpx.Response(200, json={"organic_results": []})

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        serpapi = SerpAPIClient("key", client=client, max_retries=0)
        task = SearchTask(
            keyword="MB Bank",
            intent="bị lừa",
            domain="facebook.com",
            page=1,
            window=DateWindow(date(2026, 7, 1), date(2026, 7, 7)),
            location="VN",
            language="vi",
        )
        result = await serpapi.search_task(task)
        await client.aclose()
        return result

    assert asyncio.run(run())["results"] == []
    params = captured[0].url.params
    assert params["gl"] == "vn"
    assert params["hl"] == "vi"
    assert "location" not in params
    assert params["start"] == "10"
    assert params["tbs"] == "cdr:1,cd_min:7/1/2026,cd_max:7/7/2026"


def test_serpapi_retries_transient_status_and_key_can_be_replaced():
    attempts = 0
    seen_keys = []
    delays = []

    async def handler(request):
        nonlocal attempts
        attempts += 1
        seen_keys.append(request.url.params["api_key"])
        if attempts == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "busy"})
        return httpx.Response(200, json={"organic_results": []})

    async def fake_sleep(delay):
        delays.append(delay)

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        serpapi = SerpAPIClient(
            "old-key",
            client=client,
            max_retries=1,
            backoff_base_seconds=99,
            sleep=fake_sleep,
        )
        serpapi.replace_api_key("new-key")
        result = await serpapi.search("scam")
        await client.aclose()
        return result

    assert asyncio.run(run())["results"] == []
    assert attempts == 2
    assert seen_keys == ["new-key", "new-key"]
    assert delays == [0]


def test_serpapi_provider_error_is_not_retried():
    attempts = 0

    async def handler(request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, json={"error": "Invalid API key"})

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        serpapi = SerpAPIClient("bad-key", client=client, max_retries=3)
        with pytest.raises(SerpAPIError, match="Invalid API key") as caught:
            await serpapi.search("scam")
        await client.aclose()
        return caught.value

    error = asyncio.run(run())
    assert attempts == 1
    assert error.retryable is False


def test_serpapi_google_no_results_message_is_an_empty_page():
    async def handler(request):
        return httpx.Response(
            200,
            json={"error": "Google hasn't returned any results for this query."},
        )

    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        serpapi = SerpAPIClient("key", client=client, max_retries=0)
        result = await serpapi.search("site:threads.net scam")
        await client.aclose()
        return result

    assert asyncio.run(run())["results"] == []


def test_serpapi_validates_date_bounds_and_required_key():
    assert build_date_tbs("2026-07-01", None) == "cdr:1,cd_min:7/1/2026"
    assert build_date_tbs(None, "2026-07-31") == "cdr:1,cd_max:7/31/2026"
    with pytest.raises(ValueError, match="on or before"):
        build_date_tbs("2026-08-01", "2026-07-31")
    with pytest.raises(ValueError, match="API key"):
        SerpAPIClient("")
