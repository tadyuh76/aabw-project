from data_module.pipeline import (
    build_backfill_tasks,
    canonicalize_url,
    normalize_classification,
    split_saturated_task,
)


def test_query_planner_splits_by_keyword_domain_intent_and_month():
    tasks = build_backfill_tasks(
        ["MB Bank"],
        ["facebook.com"],
        "2026-05-20",
        "2026-06-02",
        intents=["bị lừa"],
        max_pages=1,
    )
    assert len(tasks) == 2
    assert tasks[0].query == '"MB Bank" "bị lừa" site:facebook.com'
    weekly = split_saturated_task(tasks[0], max_pages=2)
    assert weekly
    assert {task.page for task in weekly} == {0, 1}


def test_query_planner_can_combine_intents_with_google_or():
    task = build_backfill_tasks(
        ["MB Bank"],
        ["facebook.com"],
        "2026-07-01",
        "2026-07-11",
        intents=["bị lừa|lừa đảo|mất tiền"],
        max_pages=1,
    )[0]
    assert task.query == (
        '"MB Bank" ("bị lừa" OR "lừa đảo" OR "mất tiền") site:facebook.com'
    )


def test_url_and_classification_normalization_are_graph_ready():
    url = canonicalize_url(
        "https://www.facebook.com/groups/demo/posts/123/?utm_source=test&b=2&a=1#x"
    )
    assert url == "https://www.facebook.com/groups/demo/posts/123?a=1&b=2"
    classification = normalize_classification(
        {
            "primary_category": "scam_report",
            "severity": 9,
            "confidence": 1.3,
            "specific_case": "true",
            "indicators": [
                {
                    "type": "phone_number",
                    "value": "+84 912 345 678",
                    "evidence_source": "post_text",
                },
                {
                    "type": "phone",
                    "value": "0912345678",
                    "evidence_source": "image",
                    "confidence": 0.5,
                },
            ],
        }
    )
    assert classification["severity"] == 5
    assert classification["confidence"] == 1
    assert classification["specific_case"] is True
    assert len(classification["indicators"]) == 1
    assert classification["indicators"][0]["normalized_value"] == "0912345678"
