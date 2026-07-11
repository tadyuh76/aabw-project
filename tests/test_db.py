import json

import httpx

from data_module.config import Settings
from data_module.db import SupabaseRepository, SupabaseRestClient


def test_rest_select_sends_service_headers_and_filters():
    captured = {}

    def handler(request):
        captured["request"] = request
        return httpx.Response(200, json=[{"id": "1"}])

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)
    rest = SupabaseRestClient(
        "https://demo.supabase.co", "secret", client=http_client
    )
    rows = rest.select(
        "crawl_jobs",
        filters={"status": "eq.queued"},
        order="created_at.desc",
        limit=5,
    )
    assert rows == [{"id": "1"}]
    request = captured["request"]
    assert request.headers["apikey"] == "secret"
    assert request.headers["authorization"] == "Bearer secret"
    assert request.url.params["status"] == "eq.queued"
    assert request.url.params["limit"] == "5"


def test_rest_select_paginated_reads_past_supabase_1000_row_cap():
    source_rows = [{"id": f"doc-{index:04d}"} for index in range(2505)]
    requests = []

    def handler(request):
        requests.append(request)
        offset = int(request.url.params.get("offset", "0"))
        requested_limit = int(request.url.params.get("limit", "1000"))
        # Supabase's Data API returns at most 1,000 rows per request.
        page_limit = min(requested_limit, 1000)
        return httpx.Response(200, json=source_rows[offset : offset + page_limit])

    rest = SupabaseRestClient(
        "https://demo.supabase.co",
        "secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    rows = rest.select_paginated(
        "documents",
        filters={"classification_status": "eq.completed"},
        order="last_seen_at.desc",
        limit=2505,
    )

    assert rows == source_rows
    assert [request.url.params["offset"] for request in requests] == [
        "0",
        "1000",
        "2000",
    ]
    assert [request.url.params["limit"] for request in requests] == [
        "1000",
        "1000",
        "505",
    ]
    assert all(
        request.url.params["order"] == "last_seen_at.desc,id.asc"
        for request in requests
    )


def test_rest_select_paginated_deduplicates_overlapping_pages():
    pages = {
        0: [{"id": "1"}, {"id": "2"}, {"id": "3"}],
        3: [{"id": "3"}, {"id": "4"}, {"id": "5"}],
        6: [{"id": "6"}],
    }

    def handler(request):
        offset = int(request.url.params.get("offset", "0"))
        return httpx.Response(200, json=pages.get(offset, []))

    rest = SupabaseRestClient(
        "https://demo.supabase.co",
        "secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    rows = rest.select_paginated(
        "documents", order="created_at.desc", limit=6, page_size=3
    )

    assert [row["id"] for row in rows] == ["1", "2", "3", "4", "5", "6"]


def test_rest_upsert_requests_merge_duplicates():
    captured = {}

    def handler(request):
        captured["request"] = request
        return httpx.Response(201, json=[{"id": "doc"}])

    rest = SupabaseRestClient(
        "https://demo.supabase.co",
        "secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = rest.upsert(
        "documents", {"url_hash": "abc"}, on_conflict="url_hash"
    )
    assert result[0]["id"] == "doc"
    request = captured["request"]
    assert request.url.params["on_conflict"] == "url_hash"
    assert "resolution=merge-duplicates" in request.headers["prefer"]


class FakeRest:
    def __init__(self):
        self.inserted = []

    def insert(self, table, payload):
        self.inserted.append((table, payload))
        return [{"id": "job-1", **payload}]


def test_repository_create_job_flattens_control_fields():
    settings = Settings(
        supabase_url="https://demo.supabase.co",
        supabase_service_role_key="secret",
        tinyfish_api_key="tiny",
        groq_api_key="groq",
    )
    fake = FakeRest()
    repository = SupabaseRepository(settings, rest=fake)
    job = repository.create_job(
        {
            "name": "MB backfill",
            "mode": "backfill",
            "parameters": {"keywords": ["MB Bank"], "agent_record_budget": 3},
        }
    )
    assert job["status"] == "queued"
    assert job["agent_budget"] == 3
    assert fake.inserted[0][0] == "crawl_jobs"


def test_classification_is_linked_to_the_originating_job():
    settings = Settings(
        supabase_url="https://demo.supabase.co",
        supabase_service_role_key="secret",
        tinyfish_api_key="tiny",
        groq_api_key="groq",
    )
    captured = {}

    class ClassificationRest:
        def upsert(self, table, payload, *, on_conflict):
            captured.update(
                table=table, payload=payload, on_conflict=on_conflict
            )
            return [{"id": "classification-1", **payload}]

    repository = SupabaseRepository(settings, rest=ClassificationRest())
    repository.upsert_classification(
        "document-1",
        {"primary_category": "scam_report", "confidence": 0.9},
        job_id="job-1",
        model="test-model",
        prompt_version="v1",
    )

    assert captured["table"] == "classifications"
    assert captured["on_conflict"] == "document_id"
    assert captured["payload"]["job_id"] == "job-1"


def test_global_analysis_documents_use_paginated_deterministic_selection():
    captured = {}

    class PaginatedRest:
        def select_paginated(self, table, **kwargs):
            captured.update(table=table, **kwargs)
            return [{"id": "doc-1"}]

    settings = Settings(
        supabase_url="https://demo.supabase.co",
        supabase_service_role_key="secret",
        tinyfish_api_key="tiny",
        groq_api_key="groq",
    )
    repository = SupabaseRepository(settings, rest=PaginatedRest())
    rows = repository.list_global_analysis_documents(limit=5000)

    assert rows == [{"id": "doc-1"}]
    assert captured["table"] == "documents"
    assert captured["limit"] == 5000
    assert captured["order"] == "last_seen_at.desc,id.asc"
    assert captured["filters"] == {"classification_status": "eq.completed"}
