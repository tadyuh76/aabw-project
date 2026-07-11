import json

import pytest

from data_module.pipeline.analytics import (
    analyze_documents,
    build_metrics,
    cluster_documents,
    detect_anomalies,
)


DOCUMENTS = [
    {
        "document_id": "doc-1",
        "category": "scam_report",
        "confidence": 0.95,
        "severity": 5,
        "scam_types": ["transfer_fraud"],
        "bank_roles": ["recipient_account_provider"],
        "indicators": [
            {"type": "phone", "value": "+84 912 345 678"},
            {"type": "bank_account", "value": "001 234 567 890"},
        ],
    },
    {
        "document_id": "doc-2",
        "category": "scam_report",
        "confidence": 0.85,
        "severity": 4,
        "scam_types": ["fake_seller"],
        "bank_roles": ["recipient_account_provider"],
        "indicators": [
            {"type": "phone_number", "value": "0912345678"},
            {"type": "domain", "value": "Evil.Example"},
        ],
    },
    {
        "document_id": "doc-3",
        "category": "impersonation_abuse",
        "confidence": 0.75,
        "severity": 3,
        "scam_types": ["phishing"],
        "bank_roles": ["impersonated_brand"],
        "indicators": [
            {"kind": "bank_account", "display_value": "001234567890"},
            {"type": "url", "value": "https://evil.example/login?utm_source=x"},
        ],
    },
    {
        "document_id": "doc-4",
        "category": "noise",
        "confidence": 0.25,
        "severity": 1,
        "scam_types": [],
        "bank_roles": [],
        "indicators": [],
    },
]


def test_metrics_are_sql_ready_and_include_evidence():
    metrics = build_metrics(DOCUMENTS)

    assert metrics["summary"] == {
        "document_count": 4,
        "unique_indicator_count": 4,
        "document_indicator_edge_count": 6,
        "average_confidence": 0.7,
        "maximum_severity": 5,
        "evidence_document_ids": ["doc-1", "doc-2", "doc-3", "doc-4"],
        "evidence_indicator_keys": [
            "bank_account|001234567890",
            "domain|evil.example",
            "phone|0912345678",
            "url|https://evil.example/login",
        ],
    }
    scam_row = next(
        row for row in metrics["by_category"] if row["category"] == "scam_report"
    )
    assert scam_row["document_count"] == 2
    assert scam_row["document_share"] == 0.5
    assert scam_row["evidence_document_ids"] == ["doc-1", "doc-2"]

    phone_row = next(
        row
        for row in metrics["by_indicator"]
        if row["indicator_key"] == "phone|0912345678"
    )
    assert phone_row["document_count"] == 2
    assert phone_row["evidence_document_ids"] == ["doc-1", "doc-2"]
    assert json.loads(json.dumps(metrics)) == metrics


def test_union_find_clusters_transitive_strong_links_and_omits_isolates():
    clusters = cluster_documents(DOCUMENTS)

    assert len(clusters) == 1
    linked = clusters[0]
    assert linked["document_ids"] == ["doc-1", "doc-2", "doc-3"]
    assert linked["document_count"] == 3
    assert linked["is_linked"] is True
    assert linked["shared_indicator_keys"] == [
        "bank_account|001234567890",
        "phone|0912345678",
    ]
    assert linked["evidence_document_ids"] == linked["document_ids"]
    assert linked["evidence_indicator_keys"] == linked["shared_indicator_keys"]

def test_weak_indicators_are_metrics_but_never_campaign_edges():
    documents = [
        {
            "document_id": "weak-1",
            "category": "scam_report",
            "confidence": 0.8,
            "severity": 3,
            "indicators": [
                {"type": "url", "value": "https://example.com/post/1"},
                {"type": "money_amount", "value": "5.000.000 VND"},
                {"type": "person_alias", "value": "Nguyen Van A"},
            ],
        },
        {
            "document_id": "weak-2",
            "category": "scam_report",
            "confidence": 0.7,
            "severity": 3,
            "indicators": [
                {"type": "url", "value": "https://example.com/post/1"},
                {"type": "money_amount", "value": "5.000.000 VND"},
                {"type": "person_alias", "value": "Nguyen Van A"},
            ],
        },
    ]

    metrics = build_metrics(documents)
    assert metrics["summary"]["unique_indicator_count"] == 3
    assert all(row["document_count"] == 2 for row in metrics["by_indicator"])

    clusters = cluster_documents(documents)
    assert clusters == []
    assert not any(
        anomaly["anomaly_type"] == "repeated_indicator"
        for anomaly in detect_anomalies(documents)
    )


def test_campaign_inference_excludes_non_scam_and_low_confidence_documents():
    documents = [
        {
            "document_id": "eligible-scam",
            "category": "scam_report",
            "confidence": 0.8,
            "severity": 4,
            "indicators": [{"type": "phone", "value": "0912345678"}],
        },
        {
            "document_id": "eligible-abuse",
            "category": "impersonation_abuse",
            "confidence": 0.6,
            "severity": 4,
            "indicators": [{"type": "phone", "value": "+84 912 345 678"}],
        },
        {
            "document_id": "low-confidence",
            "category": "scam_report",
            "confidence": 0.59,
            "severity": 4,
            "indicators": [{"type": "phone", "value": "0912345678"}],
        },
        {
            "document_id": "legitimate-news",
            "category": "news_pr",
            "confidence": 0.99,
            "severity": 4,
            "indicators": [{"type": "phone", "value": "0912345678"}],
        },
    ]

    metrics = build_metrics(documents)
    phone_metric = next(
        row for row in metrics["by_indicator"] if row["indicator_type"] == "phone"
    )
    assert phone_metric["document_count"] == 4

    clusters = cluster_documents(documents)
    assert len(clusters) == 1
    assert clusters[0]["document_ids"] == ["eligible-abuse", "eligible-scam"]

    repeated = [
        anomaly
        for anomaly in detect_anomalies(documents)
        if anomaly["anomaly_type"] == "repeated_indicator"
    ]
    assert len(repeated) == 1
    assert repeated[0]["document_count"] == 2
    assert repeated[0]["evidence_document_ids"] == [
        "eligible-abuse",
        "eligible-scam",
    ]


def test_anomalies_cover_high_severity_repeated_indicators_and_burst_size():
    anomalies = detect_anomalies(DOCUMENTS)
    by_type = {}
    for anomaly in anomalies:
        by_type.setdefault(anomaly["anomaly_type"], []).append(anomaly)

    assert [row["evidence_document_ids"] for row in by_type["high_severity"]] == [
        ["doc-1"],
        ["doc-2"],
    ]
    assert {
        row["indicator_key"] for row in by_type["repeated_indicator"]
    } == {
        "bank_account|001234567890",
        "phone|0912345678",
    }
    burst = by_type["burst_size"][0]
    assert burst["observed_value"] == 3
    assert burst["evidence_document_ids"] == ["doc-1", "doc-2", "doc-3"]
    assert burst["evidence_indicator_keys"] == [
        "bank_account|001234567890",
        "phone|0912345678",
    ]


def test_full_analysis_is_order_independent_and_handles_empty_input():
    forward = analyze_documents(DOCUMENTS)
    reverse = analyze_documents(list(reversed(DOCUMENTS)))
    assert forward == reverse

    empty = analyze_documents([])
    assert empty["metrics"]["summary"]["document_count"] == 0
    assert empty["clusters"] == []
    assert empty["anomalies"] == []


def test_inputs_are_normalized_deduplicated_and_validated():
    document = {
        "document_id": "doc-x",
        "primary_category": "unknown",
        "confidence": 99,
        "severity": 12,
        "indicators": [
            {"type": "phone_number", "value": "+84 912 345 678", "confidence": 0.2},
            {"type": "phone", "value": "0912345678", "confidence": 0.9},
        ],
    }
    result = analyze_documents([document])
    assert result["metrics"]["summary"]["document_indicator_edge_count"] == 1
    assert result["metrics"]["by_category"][0]["category"] == "noise"
    assert result["metrics"]["by_severity"][0]["severity"] == 5

    with pytest.raises(ValueError, match="Duplicate document_id"):
        analyze_documents([document, document])
    with pytest.raises(ValueError, match="repeated_indicator_threshold"):
        analyze_documents([], repeated_indicator_threshold=1)
