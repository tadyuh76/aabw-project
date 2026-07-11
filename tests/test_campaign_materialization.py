from copy import deepcopy

import pytest

from data_module.config import Settings
from data_module.db import SupabaseRepository


class CampaignRest:
    def __init__(self, tables):
        self.tables = deepcopy(tables)
        self.updated = []

    def select_paginated(self, table, **kwargs):
        rows = deepcopy(self.tables.get(table, []))
        filters = kwargs.get("filters") or {}
        for key, expression in filters.items():
            if expression == "eq.true":
                rows = [row for row in rows if row.get(key) is True]
            elif expression == "eq.false":
                rows = [row for row in rows if row.get(key) is False]
            elif expression.startswith("neq."):
                rows = [row for row in rows if row.get(key) != expression[4:]]
        limit = kwargs.get("limit")
        return rows[:limit] if limit is not None else rows

    def select(self, table, **kwargs):
        return self.select_paginated(table, **kwargs)

    def update(self, table, payload, filters):
        self.updated.append((table, deepcopy(payload), deepcopy(filters)))
        changed = []
        for row in self.tables.get(table, []):
            matches = True
            for key, expression in filters.items():
                if expression == "eq.true" and row.get(key) is not True:
                    matches = False
                elif expression == "eq.false" and row.get(key) is not False:
                    matches = False
                elif expression.startswith("eq.") and expression not in {
                    "eq.true",
                    "eq.false",
                } and str(row.get(key)) != expression[3:]:
                    matches = False
            if matches:
                row.update(payload)
                changed.append(deepcopy(row))
        return changed

    def upsert(self, table, payload, *, on_conflict):
        rows = payload if isinstance(payload, list) else [payload]
        keys = on_conflict.split(",")
        stored = self.tables.setdefault(table, [])
        results = []
        for candidate in rows:
            existing = next(
                (
                    row
                    for row in stored
                    if all(row.get(key) == candidate.get(key) for key in keys)
                ),
                None,
            )
            if existing is None:
                existing = {
                    "id": "{}-{}".format(table, len(stored) + 1),
                    "status": "provisional",
                    "analyst_confirmed": False,
                    **deepcopy(candidate),
                }
                stored.append(existing)
            else:
                existing.update(deepcopy(candidate))
            results.append(deepcopy(existing))
        return results


def _repository(rest):
    settings = Settings(
        supabase_url="https://demo.supabase.co",
        supabase_service_role_key="secret",
        tinyfish_api_key="tiny",
        groq_api_key="groq",
    )
    return SupabaseRepository(settings, rest=rest)


def _cluster(campaign_key="campaign-new"):
    return {
        "cluster_id": campaign_key,
        "campaign_key": campaign_key,
        "anchor_indicator_key": "bank_account|001234567890",
        "is_linked": True,
        "document_count": 2,
        "indicator_keys": ["bank_account|001234567890"],
        "shared_indicator_keys": ["bank_account|001234567890"],
        "maximum_severity": 4,
        "average_confidence": 0.91,
        "scam_types": ["transfer_fraud"],
        "bank_roles": ["recipient_account_provider"],
        "category_counts": [{"category": "scam_report", "document_count": 2}],
        "first_seen_at": "2026-01-01T00:00:00+00:00",
        "last_seen_at": "2026-02-01T00:00:00+00:00",
        "memberships": [
            {
                "document_id": "doc-1",
                "membership_score": 0.98,
                "reasons": [
                    {
                        "reason_type": "shared_strong_indicator",
                        "indicator_key": "bank_account|001234567890",
                        "strength": 0.98,
                    }
                ],
            },
            {
                "document_id": "doc-2",
                "membership_score": 0.98,
                "reasons": [
                    {
                        "reason_type": "shared_strong_indicator",
                        "indicator_key": "bank_account|001234567890",
                        "strength": 0.98,
                    }
                ],
            },
        ],
    }


def test_materializes_stable_campaign_memberships_and_anchor_indicator():
    rest = CampaignRest(
        {
            "campaigns": [],
            "campaign_clusters": [
                {"id": "cluster-uuid", "cluster_key": "campaign-new", "is_active": True}
            ],
            "indicators": [
                {
                    "id": "indicator-1",
                    "kind": "bank_account",
                    "normalized_value": "001234567890",
                }
            ],
            "campaign_documents": [],
            "campaign_indicators": [],
        }
    )

    counts = _repository(rest).replace_stable_campaigns(
        "job-1", {"clusters": [_cluster()]}, prune=True
    )

    assert counts == {
        "campaigns": 1,
        "campaign_documents": 2,
        "campaign_indicators": 1,
        "missing_indicators": 0,
    }
    campaign = rest.tables["campaigns"][0]
    assert campaign["campaign_key"] == "campaign-new"
    assert campaign["source_cluster_id"] == "cluster-uuid"
    assert campaign["label"] == "Transfer Fraud · Bank account ••••7890"
    assert campaign["shared_indicator_keys"] == ["bank_account|001234567890"]
    assert campaign["metadata"]["source_algorithm"] == (
        "strong_indicator_components_v3_scam_only"
    )
    assert all(row["reasons"] for row in rest.tables["campaign_documents"])
    anchor = rest.tables["campaign_indicators"][0]
    assert anchor["role"] == "anchor"
    assert anchor["indicator_id"] == "indicator-1"
    assert all(
        "id" in filters
        for table, _, filters in rest.updated
        if table == "campaigns"
    )


def test_derivative_cluster_records_scam_only_algorithm_version():
    class AnalyticsRest:
        def __init__(self):
            self.upserts = []

        def upsert(self, table, payload, *, on_conflict):
            self.upserts.append((table, deepcopy(payload), on_conflict))
            if table == "campaign_clusters":
                return [{"id": "cluster-uuid", **deepcopy(payload)}]
            return deepcopy(payload) if isinstance(payload, list) else [deepcopy(payload)]

        def delete(self, table, filters):
            return []

        def update(self, table, payload, filters):
            return []

    rest = AnalyticsRest()
    _repository(rest).replace_live_analytics(
        "job-1", {"metrics": {}, "clusters": [_cluster()], "anomalies": []}
    )

    cluster_payload = next(
        payload for table, payload, _ in rest.upserts if table == "campaign_clusters"
    )
    assert cluster_payload["algorithm"] == (
        "strong_indicator_components_v3_scam_only"
    )


@pytest.mark.parametrize(
    "mutation",
    (
        {"category_counts": [{"category": "noise", "document_count": 2}]},
        {
            "anchor_indicator_key": "message_template|verify before 11 pm",
            "indicator_keys": ["message_template|verify before 11 pm"],
            "shared_indicator_keys": ["message_template|verify before 11 pm"],
        },
    ),
)
def test_persistence_rejects_non_scam_or_phrase_only_clusters(mutation):
    cluster = _cluster()
    cluster.update(mutation)
    rest = CampaignRest(
        {
            "campaigns": [],
            "campaign_clusters": [],
            "indicators": [],
            "campaign_documents": [],
            "campaign_indicators": [],
        }
    )

    with pytest.raises(ValueError, match="scam-only cluster"):
        _repository(rest).replace_stable_campaigns(
            "job-1", {"clusters": [cluster]}, prune=True
        )


def test_reuses_confirmed_campaign_on_shared_indicator_without_overwriting_label():
    existing = {
        "id": "campaign-stable-id",
        "campaign_key": "campaign-analyst-stable",
        "anchor_indicator_key": "phone|0912345678",
        "label": "Analyst-confirmed relay",
        "status": "confirmed",
        "analyst_confirmed": True,
        "is_active": True,
        "updated_at": "2026-07-01T00:00:00+00:00",
        "metadata": {"shared_indicator_keys": ["bank_account|001234567890"]},
    }
    rest = CampaignRest(
        {
            "campaigns": [existing],
            "campaign_clusters": [
                {"id": "cluster-uuid", "cluster_key": "campaign-new", "is_active": True}
            ],
            "indicators": [
                {
                    "id": "indicator-bank",
                    "kind": "bank_account",
                    "normalized_value": "001234567890",
                },
                {
                    "id": "indicator-phone",
                    "kind": "phone",
                    "normalized_value": "0912345678",
                },
            ],
            "campaign_documents": [],
            "campaign_indicators": [],
        }
    )

    _repository(rest).replace_stable_campaigns(
        "job-1", {"clusters": [_cluster()]}, prune=True
    )

    assert len(rest.tables["campaigns"]) == 1
    campaign = rest.tables["campaigns"][0]
    assert campaign["campaign_key"] == "campaign-analyst-stable"
    assert campaign["anchor_indicator_key"] == "phone|0912345678"
    assert campaign["label"] == "Analyst-confirmed relay"
    assert campaign["status"] == "confirmed"
    roles = {
        row["indicator_id"]: row["role"]
        for row in rest.tables["campaign_indicators"]
    }
    assert roles == {
        "indicator-bank": "shared",
        "indicator-phone": "anchor",
    }


def test_refresh_preserves_a_nonblank_provisional_analyst_label():
    existing = {
        "id": "campaign-existing",
        "campaign_key": "campaign-new",
        "anchor_indicator_key": "bank_account|001234567890",
        "label": "Manual fraud-team label",
        "status": "provisional",
        "analyst_confirmed": False,
        "is_active": True,
        "updated_at": "2026-07-01T00:00:00+00:00",
        "metadata": {"label_source": "generated"},
    }
    rest = CampaignRest(
        {
            "campaigns": [existing],
            "campaign_clusters": [
                {"id": "cluster-uuid", "cluster_key": "campaign-new", "is_active": True}
            ],
            "indicators": [
                {
                    "id": "indicator-1",
                    "kind": "bank_account",
                    "normalized_value": "001234567890",
                }
            ],
            "campaign_documents": [],
            "campaign_indicators": [],
        }
    )

    _repository(rest).replace_stable_campaigns(
        "job-1", {"clusters": [_cluster()]}, prune=True
    )

    assert rest.tables["campaigns"][0]["label"] == "Manual fraud-team label"
