import asyncio
from types import SimpleNamespace

from data_module.config import Settings
from data_module.orchestrator import CrawlPipeline


class MemoryRepository:
    def __init__(self, job):
        self.job = dict(job)
        self.items = {}
        self.documents = {}
        self.events = []
        self.comments = []
        self.media = []
        self.classifications = []
        self.indicators = []
        self.usage = []

    def update_job(self, job_id, **changes):
        self.job.update(changes)
        return dict(self.job)

    def increment_job(self, job_id, **increments):
        for key, amount in increments.items():
            self.job[key] = int(self.job.get(key) or 0) + amount
        return dict(self.job)

    def get_job(self, job_id):
        return dict(self.job)

    def add_event(self, job_id, stage, message, **kwargs):
        row = {"job_id": job_id, "stage": stage, "message": message, **kwargs}
        self.events.append(row)
        return row

    def get_item_by_key(self, job_id, key):
        return self.items.get((job_id, key))

    def upsert_item(self, payload):
        key = (payload["job_id"], payload["idempotency_key"])
        existing = self.items.get(key, {"id": "item-{}".format(len(self.items) + 1)})
        existing.update(payload)
        self.items[key] = existing
        return dict(existing)

    def update_item(self, item_id, **changes):
        for item in self.items.values():
            if item["id"] == item_id:
                item.update(changes)
                return dict(item)
        raise KeyError(item_id)

    def list_items(self, job_id, **kwargs):
        rows = [item for (owner, _), item in self.items.items() if owner == job_id]
        if kwargs.get("item_type"):
            rows = [item for item in rows if item["item_type"] == kwargs["item_type"]]
        return [dict(item) for item in rows]

    def get_document_by_hash(self, url_hash):
        for document in self.documents.values():
            if document["url_hash"] == url_hash:
                return dict(document)
        return None

    def upsert_document(self, payload):
        existing = self.get_document_by_hash(payload["url_hash"])
        document = existing or {"id": "doc-{}".format(len(self.documents) + 1)}
        document.update(payload)
        self.documents[document["id"]] = document
        return dict(document)

    def get_document(self, document_id):
        row = self.documents.get(document_id)
        return dict(row) if row else None

    def replace_comments(self, document_id, comments):
        self.comments = list(comments)

    def replace_media(self, document_id, media, run_id):
        self.media = list(media)

    def upsert_classification(self, document_id, classification, **kwargs):
        self.classifications.append(dict(classification))
        return dict(classification)

    def upsert_indicators(self, document_id, indicators):
        self.indicators.extend(indicators)
        return len(indicators)

    def add_usage(self, *args, **kwargs):
        self.usage.append((args, kwargs))
        return {"id": len(self.usage)}


class FakeSerpAPI:
    search_calls = 0

    def __init__(self, api_key):
        self.api_key = api_key

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def search_task(self, task):
        type(self).search_calls += 1
        return {
            "results": [
                {
                    "position": 1,
                    "title": "Em bị lừa chuyển khoản qua MB Bank",
                    "snippet": "Mất 14 triệu",
                    "url": "https://facebook.com/groups/demo/posts/123?utm_source=x",
                }
            ]
        }


class FakeTinyFish:
    fetch_calls = 0
    agent_calls = 0

    def __init__(self, api_key):
        self.api_key = api_key

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def fetch_urls(self, urls):
        type(self).fetch_calls += 1
        return {
            "results": [
                {
                    "url": urls[0],
                    "title": "Em bị lừa",
                    "text": "Mình đã chuyển khoản và bị chặn.",
                    "image_links": ["https://example.com/evidence.jpg"],
                    "language": "vi",
                }
            ],
            "errors": [],
        }

    @staticmethod
    def should_deep_enrich(result):
        return bool(result.get("image_links"))

    async def run_agent(self, url, **kwargs):
        type(self).agent_calls += 1
        return {
            "run_id": "agent-1",
            "status": "COMPLETED",
            "num_of_steps": 3,
            "result": {
                "post_text": "Mình đã chuyển 14 triệu rồi bị shop chặn.",
                "author_display_name": "Victim",
                "published_at": "2026-07-01T00:00:00Z",
                "comments": [{"body": "Tôi cũng bị", "author_display_name": "Other"}],
                "media": [
                    {
                        "source_url": "https://example.com/evidence.jpg",
                        "media_type": "screenshot",
                        "visual_description": "Transfer receipt for 14,000,000 VND",
                        "qr_present": False,
                    }
                ],
            },
        }


class FakeOpenAI:
    calls = 0

    def __init__(self, api_key, model, **kwargs):
        self.model = model

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def classify(self, evidence, **kwargs):
        type(self).calls += 1
        return SimpleNamespace(
            classification={
                "primary_category": "scam_report",
                "scam_types": ["transfer_fraud"],
                "bank_roles": ["recipient_account_provider"],
                "specific_case": True,
                "first_person_report": True,
                "summary": "Victim reports a transfer scam",
                "severity": 3,
                "confidence": 0.95,
                "indicators": [
                    {
                        "type": "money_amount",
                        "value": "14 triệu",
                        "normalized_value": "14000000 VND",
                        "evidence_source": "post_text",
                    }
                ],
                "media_findings": [],
            },
            usage={"input_tokens": 100, "output_tokens": 50, "total_tokens": 150},
            model=self.model,
            prompt_version="test-v1",
            response_id="response-1",
            vision_fallback_reason=None,
        )


def test_pipeline_persists_enriched_classified_document_and_is_resumable():
    job = {
        "id": "job-1",
        "name": "MB test",
        "mode": "backfill",
        "status": "queued",
        "parameters": {
            "keywords": ["MB Bank"],
            "target_domains": ["facebook.com"],
            "scam_intents": ["bị lừa"],
            "date_from": "2026-07-01",
            "date_to": "2026-07-02",
            "max_search_pages": 1,
            "manual_deep_scan": True,
            "agent_comment_limit": 10,
            "agent_timeout_seconds": 180,
        },
        "agent_budget": 1,
        "agent_used": 0,
    }
    repository = MemoryRepository(job)
    settings = Settings(
        supabase_url="https://demo.supabase.co",
        supabase_service_role_key="service",
        tinyfish_api_key="tiny",
        serpapi_api_key="serp",
        openai_api_key="openai",
        openai_model="test-model",
    )
    pipeline = CrawlPipeline(
        settings,
        repository,
        tinyfish_factory=FakeTinyFish,
        serpapi_factory=FakeSerpAPI,
        openai_factory=FakeOpenAI,
    )

    asyncio.run(pipeline.run_job_async(job))

    assert repository.job["status"] == "completed"
    assert len(repository.documents) == 1
    document = next(iter(repository.documents.values()))
    assert document["agent_enriched"] is True
    assert document["classification_status"] == "completed"
    assert repository.comments[0]["body"] == "Tôi cũng bị"
    assert repository.media[0]["qr_present"] is False
    assert repository.classifications[0]["primary_category"] == "scam_report"
    assert repository.indicators[0]["type"] == "money_amount"
    assert repository.job["agent_used"] == 1

    search_calls = FakeSerpAPI.search_calls
    asyncio.run(pipeline.run_job_async(dict(repository.job)))
    assert FakeSerpAPI.search_calls == search_calls
    assert len(repository.documents) == 1
