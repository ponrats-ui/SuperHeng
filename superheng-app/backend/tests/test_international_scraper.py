"""Tests for the international ingestion: Laos (Kapook) and Vietnam (xosodaiphat).

What is worth testing here is not that a regex matches — it is the handful of ways
a date-addressable source can hand back a **wrong row**, because this script writes
into an immutable ledger and the premium model then trains on whatever lands there:

* Kapook addresses a draw by the **Buddhist** year. Requesting the common-era
  spelling returns HTTP 200 and a *valid* page — its homepage — so a bug in the
  date arithmetic looks like "no draws", not like an error.
* A non-draw date and a date that has not been drawn yet both answer HTTP 200. They
  must be read as "nothing here", never as a failure and never as a row.
* Both pages state their own date. A page that disagrees with the date requested is
  the one failure that would silently mis-date the ledger, so it is refused.
* Laos publishes the tail of its first prize as the 2-digit prize while Thailand
  draws one separately. The parser asserts that agreement instead of passing it
  through, so a half-changed format is caught at the source.

The fixtures are real markup captured from both sites (see the provenance comment
in each file), trimmed to the elements the parsers read. The undrawn pages are the
real thing too, because "what a missing result looks like" is a fact about the
site, not something to be invented here.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import grant_premium
from models.bayesian import POSITION_NAMES, analyse_positions
from scripts import scrape_international as intl
from scripts.scrape_international import (
    PRIZE_DIGITS,
    InternationalDraw,
    candidate_dates,
    dedupe_rows,
    lao_draw_url,
    parse_draw_html,
    parse_lao_html,
    parse_xsmb_html,
    xsmb_draw_url,
)

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# The draw dates the fixtures were captured from.
LAO_DATE = date(2026, 10, 13)
LAO_PRIZE = "487658"
LAO_BOTTOM_TWO = "58"

VIETNAM_DATE = date(2026, 10, 13)
VIETNAM_PRIZE = "53618"


# ---------------------------------------------------------------------------
# The fixtures are the real thing
# ---------------------------------------------------------------------------


def test_the_fixtures_are_real_trimmed_markup_not_hand_written():
    """Guard against a future edit quietly replacing these with toy HTML.

    A hand-written imitation would test the imitation, not the source — and the
    classes below are exactly what the parsers key on.
    """
    lao = fixture("kapook_lao_2026-10-13.html")
    assert "lottery.kapook.com/laolottery/13102569" in lao  # the provenance comment
    assert 'class="result-num win-6"' in lao
    assert "เลข 6 ตัว" in lao and "เลขท้าย 2 ตัว" in lao

    vietnam = fixture("xosodaiphat_xsmb_2026-10-13.html")
    assert "xosodaiphat.com/xsmb-13-10-2026.html" in vietnam
    assert "special-prize-lg" in vietnam

    for name in (
        "kapook_lao_2026-10-10_no_draw.html",
        "xosodaiphat_xsmb_2026-10-20_undrawn.html",
    ):
        assert "Provenance:" in fixture(name)


# ---------------------------------------------------------------------------
# URLs: the two sources disagree about what a year is
# ---------------------------------------------------------------------------


def test_the_lao_url_uses_the_buddhist_year():
    # 2026 + 543 = 2569, and the stamp is DDMMYYYY, not YYYYMMDD.
    assert lao_draw_url(LAO_DATE) == "https://lottery.kapook.com/laolottery/13102569"


def test_the_vietnam_url_uses_the_common_era_and_a_hyphenated_date():
    assert (
        xsmb_draw_url(VIETNAM_DATE)
        == "https://xosodaiphat.com/xsmb-13-10-2026.html"
    )


def test_draw_url_dispatches_and_refuses_an_unknown_ledger():
    assert intl.draw_url("laos", LAO_DATE).endswith("/laolottery/13102569")
    assert intl.draw_url("vietnam", VIETNAM_DATE).endswith("/xsmb-13-10-2026.html")
    with pytest.raises(ValueError):
        intl.draw_url("thai", LAO_DATE)


# ---------------------------------------------------------------------------
# Laos parsing
# ---------------------------------------------------------------------------


def test_the_lao_draw_page_parses_to_its_own_number():
    draw, reason = parse_lao_html(
        fixture("kapook_lao_2026-10-13.html"), LAO_DATE, lao_draw_url(LAO_DATE)
    )

    assert reason == ""
    assert draw is not None
    assert (draw.lottery_type, draw.draw_date) == ("laos", LAO_DATE)
    assert draw.first_prize == LAO_PRIZE
    # Read from the page's เลขท้าย 2 ตัว block, not computed — the parser asserts it
    # agrees with the tail of the 6-digit prize and would refuse the row otherwise.
    assert draw.bottom_two == LAO_BOTTOM_TWO
    assert draw.as_row() == {
        "lottery_type": "laos",
        "draw_date": "2026-10-13",
        "first_prize": "487658",
        "bottom_two": "58",
    }


def test_a_lao_date_with_no_draw_is_a_skip_not_a_failure():
    """Kapook serves its homepage, with HTTP 200, for a date that had no draw."""
    draw, reason = parse_lao_html(
        fixture("kapook_lao_2026-10-10_no_draw.html"),
        date(2026, 10, 10),
        lao_draw_url(date(2026, 10, 10)),
    )

    assert draw is None
    assert "undrawn date" in reason


def test_a_lao_page_for_the_wrong_date_is_refused():
    """The one failure that would silently mis-date every row it wrote."""
    draw, reason = parse_lao_html(
        fixture("kapook_lao_2026-10-13.html"),
        date(2026, 10, 12),  # asked for the 12th, the page is the 13th
        lao_draw_url(date(2026, 10, 12)),
    )

    assert draw is None
    assert "dated 2026-10-13" in reason and "2026-10-12 was requested" in reason


def test_a_lao_tail_that_disagrees_with_the_first_prize_is_refused():
    """A half-changed format must not be written, so the mismatch is caught here."""
    html = fixture("kapook_lao_2026-10-13.html").replace(
        '<strong class="result-num large">58</strong>',
        '<strong class="result-num large">99</strong>',
    )

    draw, reason = parse_lao_html(html, LAO_DATE, lao_draw_url(LAO_DATE))

    assert draw is None
    assert "99" in reason and "487658" in reason


def test_a_lao_page_with_the_wrong_width_of_first_prize_is_refused():
    html = fixture("kapook_lao_2026-10-13.html").replace("487658", "48765")

    draw, reason = parse_lao_html(html, LAO_DATE, lao_draw_url(LAO_DATE))

    assert draw is None
    assert "no usable" in reason


# ---------------------------------------------------------------------------
# Vietnam parsing
# ---------------------------------------------------------------------------


def test_the_vietnam_draw_page_parses_to_a_five_digit_prize():
    draw, reason = parse_xsmb_html(
        fixture("xosodaiphat_xsmb_2026-10-13.html"),
        VIETNAM_DATE,
        xsmb_draw_url(VIETNAM_DATE),
    )

    assert reason == ""
    assert draw is not None
    assert (draw.lottery_type, draw.draw_date) == ("vietnam", VIETNAM_DATE)
    # Five digits, stored as five. The ledger is 5 wide for this country because the
    # prize is — not padded to six to match Thailand.
    assert draw.first_prize == VIETNAM_PRIZE
    assert len(draw.first_prize) == PRIZE_DIGITS["vietnam"] == 5
    # Vietnam's đề: the last two digits of the special prize, by rule.
    assert draw.bottom_two == "18"


def test_a_vietnam_date_not_drawn_yet_is_a_skip_not_a_failure():
    draw, reason = parse_xsmb_html(
        fixture("xosodaiphat_xsmb_2026-10-20_undrawn.html"),
        date(2026, 10, 20),
        xsmb_draw_url(date(2026, 10, 20)),
    )

    assert draw is None
    assert "not drawn yet" in reason


def test_a_vietnam_page_for_the_wrong_date_is_refused():
    draw, reason = parse_xsmb_html(
        fixture("xosodaiphat_xsmb_2026-10-13.html"),
        date(2026, 10, 11),
        xsmb_draw_url(date(2026, 10, 11)),
    )

    assert draw is None
    assert "dated 2026-10-13" in reason


def test_a_six_digit_special_prize_is_refused_rather_than_trimmed():
    """A six-digit read means the selector has started matching something else."""
    html = fixture("xosodaiphat_xsmb_2026-10-13.html").replace(">53618<", ">053618<")

    draw, reason = parse_xsmb_html(html, VIETNAM_DATE, xsmb_draw_url(VIETNAM_DATE))

    assert draw is None
    assert "not 5 digits" in reason


def test_parse_draw_html_dispatches_by_ledger():
    lao, _ = parse_draw_html(
        "laos", fixture("kapook_lao_2026-10-13.html"), LAO_DATE, lao_draw_url(LAO_DATE)
    )
    vietnam, _ = parse_draw_html(
        "vietnam",
        fixture("xosodaiphat_xsmb_2026-10-13.html"),
        VIETNAM_DATE,
        xsmb_draw_url(VIETNAM_DATE),
    )
    assert lao is not None and vietnam is not None
    with pytest.raises(ValueError):
        parse_draw_html("thai", "", LAO_DATE, "https://example.invalid")


# ---------------------------------------------------------------------------
# The row refuses anything the table would refuse
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "kwargs",
    [
        {"lottery_type": "laos", "first_prize": "48765", "bottom_two": "65"},
        {"lottery_type": "vietnam", "first_prize": "487658", "bottom_two": "58"},
        {"lottery_type": "laos", "first_prize": "48765A", "bottom_two": "5A"},
        {"lottery_type": "vietnam", "first_prize": "5361", "bottom_two": "61"},
        {"lottery_type": "vietnam", "first_prize": "53618", "bottom_two": "8"},
        {"lottery_type": "thai", "first_prize": "402701", "bottom_two": "01"},
    ],
)
def test_a_row_that_would_violate_the_table_cannot_be_built(kwargs):
    with pytest.raises(ValueError):
        InternationalDraw(draw_date=VIETNAM_DATE, source_url="https://x", **kwargs)


def test_the_scraper_and_the_api_agree_on_how_wide_each_ledger_is():
    """Two halves of one contract: what is written, and what is modelled.

    A drift between them is invisible in isolation — the scraper would keep writing
    five-digit rows while the endpoint asked the model for six positions, and every
    Vietnam request would report a dropped row instead of a prediction.
    """
    import main

    api_widths = {kind.value: main.LOTTERY_PRIZE_DIGITS[kind] for kind in main.LotteryType}
    # The endpoint models all three ledgers; this script owns the two non-Thai ones,
    # and must agree on those.
    assert set(api_widths) == {"thai", *intl.LOTTERY_TYPES}
    assert {kind: api_widths[kind] for kind in intl.LOTTERY_TYPES} == intl.PRIZE_DIGITS


# ---------------------------------------------------------------------------
# Which dates get requested
# ---------------------------------------------------------------------------


def test_lao_candidates_skip_the_weekend():
    # 5-11 Oct 2026 is Mon..Sun, so the 10th and 11th are the weekend.
    days = candidate_dates("laos", date(2026, 10, 5), date(2026, 10, 11))

    assert days == [date(2026, 10, day) for day in (5, 6, 7, 8, 9)]
    assert all(day.weekday() < 5 for day in days)


def test_vietnam_candidates_include_the_weekend():
    days = candidate_dates("vietnam", date(2026, 10, 5), date(2026, 10, 11))

    assert days == [date(2026, 10, day) for day in range(5, 12)]


def test_all_days_overrides_the_lao_schedule_for_a_backfill():
    days = candidate_dates("laos", date(2026, 10, 10), date(2026, 10, 11), all_days=True)

    assert days == [date(2026, 10, 10), date(2026, 10, 11)]


def test_the_window_is_inclusive_at_both_ends():
    days = candidate_dates("vietnam", date(2026, 10, 13), date(2026, 10, 13))

    assert days == [date(2026, 10, 13)]


# ---------------------------------------------------------------------------
# De-duplication keys on the pair, not the date
# ---------------------------------------------------------------------------


def test_dedupe_keeps_two_countries_drawing_on_the_same_date():
    rows = [
        {"lottery_type": "laos", "draw_date": "2026-10-13", "first_prize": "487658"},
        {"lottery_type": "vietnam", "draw_date": "2026-10-13", "first_prize": "53618"},
    ]

    kept, dropped = dedupe_rows(rows)

    assert dropped == 0
    assert len(kept) == 2


def test_dedupe_collapses_the_same_ledger_and_date():
    """PostgreSQL refuses one statement that touches a conflict target twice."""
    rows = [
        {"lottery_type": "laos", "draw_date": "2026-10-13", "first_prize": "487658"},
        {"lottery_type": "laos", "draw_date": "2026-10-13", "first_prize": "999999"},
    ]

    kept, dropped = dedupe_rows(rows)

    assert dropped == 1
    assert kept[0]["first_prize"] == "999999"  # the last one wins


# ---------------------------------------------------------------------------
# Collection walks dates and paces itself
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, text: str | None) -> None:
        self.text = text


def test_collect_calls_a_no_draw_date_a_note_and_still_writes_the_others(monkeypatch):
    """One undrawn date in the window must not fail the run or invent a row."""
    pages = {
        "https://lottery.kapook.com/laolottery/12102569": fixture(
            "kapook_lao_2026-10-13.html"
        ),
        "https://lottery.kapook.com/laolottery/13102569": fixture(
            "kapook_lao_2026-10-13.html"
        ),
    }
    calls: list[str] = []

    def fake_fetch(session, url, **kwargs):
        calls.append(url)
        if url.endswith("10102569"):  # the Saturday: no draw
            return fixture("kapook_lao_2026-10-10_no_draw.html")
        return pages.get(url)

    monkeypatch.setattr(intl, "fetch_url", fake_fetch)

    draws, notes, requests_made = intl.collect(
        None,
        "laos",
        [date(2026, 10, 10), date(2026, 10, 12), LAO_DATE],
        min_interval=0,
    )

    assert requests_made == 3
    assert len(calls) == 3
    # One row: only the 13th's own page came back for the 13th. The 10th had no draw,
    # and the 12th was answered with the 13th's page — which the date guard threw out
    # rather than filing under the wrong day. Neither is an error.
    assert [draw.draw_date for draw in draws] == [LAO_DATE]
    assert len(notes) == 2
    assert any("undrawn date" in note for note in notes)
    assert any("dated 2026-10-13" in note for note in notes)


def test_collect_requests_are_paced(monkeypatch):
    """A date walk is many requests from one host, so the floor matters."""
    slept: list[float] = []

    def fake_fetch(session, url, **kwargs):
        return fixture("kapook_lao_2026-10-10_no_draw.html")

    # A clock that advances by whatever was slept, so the pacing loop sees the same
    # arithmetic it sees in production rather than a frozen zero.
    clock = [1_000.0]

    def fake_sleep(seconds: float) -> None:
        slept.append(seconds)
        clock[0] += seconds

    monkeypatch.setattr(intl, "fetch_url", fake_fetch)
    monkeypatch.setattr(intl.time, "sleep", fake_sleep)
    monkeypatch.setattr(intl.time, "monotonic", lambda: clock[0])

    intl.collect(None, "laos", [date(2026, 10, 9), date(2026, 10, 12)], min_interval=1.5)

    # The first request is never delayed; each later one waits out the interval.
    assert slept == [1.5]


# ---------------------------------------------------------------------------
# What the scraped rows do when they reach the model
# ---------------------------------------------------------------------------


def vietnam_ledger(count: int = 120) -> list[dict[str, str]]:
    """A Hanoi-shaped ledger: five-digit prizes, newest first as the API fetches it."""
    rows = [
        {
            "draw_date": (date(2026, 1, 1) + timedelta(days=index)).isoformat(),
            "first_prize": f"{index % 100000:05d}",
            "bottom_two": f"{index % 100:02d}",
        }
        for index in range(count)
    ]
    return list(reversed(rows))


def test_a_five_digit_ledger_publishes_five_positions_not_six():
    payload = analyse_positions(vietnam_ledger())

    assert payload["prize_digits"] == 5
    assert set(payload["positions"]) == set(POSITION_NAMES[1:])
    # The five-digit prize's leading position is a ten-thousands, and it is the one
    # ranked on its marginal — there is no hundred-thousands above it to condition on.
    assert payload["positions"]["ten_thousands"]["conditioned_on"] is None
    assert payload["positions"]["thousands"]["conditioned_on"] == "ten_thousands"
    # Nothing was padded, so no position is a structural zero.
    assert payload["positions"]["ten_thousands"]["usable"] is True
    assert "five digits" in payload["methodology"]


def test_a_six_digit_ledger_is_untouched_by_the_five_digit_path():
    rows = [
        {
            "draw_date": (date(2026, 1, 1) + timedelta(days=index)).isoformat(),
            "first_prize": f"{index % 1000000:06d}",
        }
        for index in range(120)
    ]

    payload = analyse_positions(list(reversed(rows)))

    assert payload["prize_digits"] == 6
    assert set(payload["positions"]) == set(POSITION_NAMES)
    assert "six digits" in payload["methodology"]


def test_the_endpoint_asks_for_five_positions_under_the_vietnam_ledger(
    monkeypatch: pytest.MonkeyPatch,
):
    """The wiring, end to end: `?type=vietnam` -> five positions in the response.

    `analyse_positions` can infer a five-digit ledger from its rows, so the model
    tests above would pass even if the endpoint never passed the width down. This
    is the check that the country actually reaches the model, over HTTP.
    """
    import main

    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(
        main,
        "fetch_draw_history",
        lambda _client, _limit, _kind: vietnam_ledger(120),
    )
    # The endpoint is behind an entitlement check now; this test is about which
    # positions a five-digit prize produces, not about who may read them.
    grant_premium()
    client = TestClient(main.app)

    payload = client.get("/api/predict/premium", params={"type": "vietnam"}).json()

    assert payload["lottery_type"] == "vietnam"
    assert payload["prize_digits"] == 5
    assert set(payload["positions"]) == set(POSITION_NAMES[1:])
    assert all(item["usable"] for item in payload["positions"].values())


def test_mixed_widths_are_dropped_with_a_warning_not_silently_folded():
    rows = [
        {"draw_date": "2026-01-01", "first_prize": "53618"},
        {"draw_date": "2026-01-02", "first_prize": "123456"},  # the stray
        {"draw_date": "2026-01-03", "first_prize": "53619"},
    ]

    payload = analyse_positions(rows, length=5)

    assert payload["draws_analyzed"] == 2
    assert payload["prize_digits"] == 5
    assert any("not exactly 5 digits" in warning for warning in payload["warnings"])
