import datetime as dt

import pytest

from data_module.ytd_backfill import DOMAIN_GROUPS, build_ytd_shards


def test_current_year_shards_stop_at_today_and_preserve_domain_groups():
    today = dt.date(2026, 7, 11)
    shards = build_ytd_shards(2026, today=today)

    assert len(shards) == 7 * len(DOMAIN_GROUPS)
    assert {(shard.month, shard.group) for shard in shards} == {
        (month, group)
        for month in range(1, 8)
        for group, _ in DOMAIN_GROUPS
    }
    july = [shard for shard in shards if shard.month == 7]
    assert {shard.date_from for shard in july} == {dt.date(2026, 7, 1)}
    assert {shard.date_to for shard in july} == {today}
    assert {
        shard.group: shard.domains for shard in shards if shard.month == 1
    } == dict(DOMAIN_GROUPS)


def test_past_year_generates_all_complete_months_and_future_year_is_rejected():
    shards = build_ytd_shards(2025, today=dt.date(2026, 7, 11))

    assert len(shards) == 12 * len(DOMAIN_GROUPS)
    december = [shard for shard in shards if shard.month == 12]
    assert {shard.date_from for shard in december} == {dt.date(2025, 12, 1)}
    assert {shard.date_to for shard in december} == {dt.date(2025, 12, 31)}

    with pytest.raises(ValueError, match="future"):
        build_ytd_shards(2027, today=dt.date(2026, 7, 11))
