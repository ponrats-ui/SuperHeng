"""Tests for the Day 5 scraper upgrade: the Sanook HTML archive path.

Two things are worth testing here, and they are the two the request singled out:
the **Thai date parser** (abbreviations, 2-digit Buddhist years, BE -> CE) and
the **number cleaning plus skip-on-malformed** rule.

Most of the date tests are pure string work, so they are fast and hermetic. The
archive tests run against markup captured from the live site and stored in
``tests/fixtures`` — the real ``<article class="archive--lotto">`` blocks,
unmodified, including their real Thai date cells. That matters: a hand-written
imitation of the markup would test the imitation, not Sanook.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta
from pathlib import Path

import pytest
from bs4 import BeautifulSoup

import scraper
from scraper import (
    Collection,
    ScrapedDraw,
    clean_number,
    find_missing_draw_dates,
    myhora_url,
    parse_myhora_html,
    parse_sanook_archive_page,
    parse_thai_date,
    thai_month_number,
    to_ce_year,
    validate_draw,
    years_before,
)

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Source check: the fixtures are the real thing
# ---------------------------------------------------------------------------


def test_fixtures_are_real_trimmed_markup_not_hand_written():
    """Guard against a future edit quietly replacing the fixtures with toy HTML."""
    for name, expected_blocks in (
        ("sanook_archive_page1.html", 21),
        ("sanook_archive_page3.html", 20),
    ):
        html = fixture(name)
        # Counted through the parser's own selector, so this is the number of
        # blocks the scraper will actually see (the provenance comment also
        # mentions the tag, and must not be mistaken for a draw).
        assert len(BeautifulSoup(html, "html.parser").select("article.archive--lotto")) == (
            expected_blocks
        )
        assert "news.sanook.com/lotto/archive" in html  # the provenance comment
        # The exact selectors the parser depends on, straight from Sanook.
        assert 'class="archive--lotto__date"' in html
        assert 'class="archive--lotto__result-number"' in html


# ---------------------------------------------------------------------------
# Thai month names and abbreviations
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("มกราคม", 1), ("ม.ค.", 1), ("มค", 1), ("มกรา", 1),
        ("กุมภาพันธ์", 2), ("ก.พ.", 2), ("กพ", 2),
        ("มีนาคม", 3), ("มี.ค.", 3), ("มีค", 3),
        ("เมษายน", 4), ("เม.ย.", 4), ("เมย", 4),
        ("พฤษภาคม", 5), ("พ.ค.", 5), ("พค", 5),
        ("มิถุนายน", 6), ("มิ.ย.", 6), ("มิย", 6),
        ("กรกฎาคม", 7), ("ก.ค.", 7), ("กค", 7),
        ("สิงหาคม", 8), ("ส.ค.", 8), ("สค", 8),
        ("กันยายน", 9), ("ก.ย.", 9), ("กย", 9),
        ("ตุลาคม", 10), ("ต.ค.", 10), ("ตค", 10), ("ตุลา", 10),
        ("พฤศจิกายน", 11), ("พ.ย.", 11), ("พย", 11),
        ("ธันวาคม", 12), ("ธ.ค.", 12), ("ธค", 12),
    ],
)
def test_thai_month_number_accepts_names_and_abbreviations(token: str, expected: int):
    assert thai_month_number(token) == expected


def test_the_dotted_abbreviations_are_not_confused_with_each_other():
    """ม.ค./มี.ค./ก.พ./พ.ค. differ by one mark, so they must not collapse."""
    assert thai_month_number("ม.ค.") == 1
    assert thai_month_number("มี.ค.") == 3
    assert thai_month_number("ก.พ.") == 2
    assert thai_month_number("พ.ค.") == 5
    assert thai_month_number("พ.ย.") == 11
    assert thai_month_number("พฤษภาคม") == 5


def test_a_non_month_thai_word_is_not_a_month():
    assert thai_month_number("ตรวจหวย") is None
    assert thai_month_number("รางวัลที่") is None
    assert thai_month_number("") is None


# ---------------------------------------------------------------------------
# Buddhist era -> Gregorian
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("year", "expected"),
    [
        (2569, 2026),  # 4-digit BE, the common form
        (2549, 2006),
        (2500, 1957),
        (2599, 2056),
        (2026, 2026),  # 4-digit CE, not shifted
        (1999, 1999),
        (69, 2026),  # 2-digit BE, resolved against the 25xx century
        (58, 2015),
        (49, 2006),
    ],
)
def test_to_ce_year_handles_both_eras_and_both_widths(year: int, expected: int):
    assert to_ce_year(year) == expected


def test_to_ce_year_rejects_what_it_cannot_resolve():
    assert to_ce_year(543) is None  # would be year 0
    assert to_ce_year(1500) is None
    assert to_ce_year(3000) is None


def test_two_digit_ce_is_refused_unless_the_text_marks_it_as_ce():
    """`69` is Buddhist 2569 in Thai text, but Gregorian 69 only if you say so."""
    assert to_ce_year(69) == 2026
    assert to_ce_year(69, ce_hint=True) is None  # out of the plausible CE range
    assert to_ce_year(2026, ce_hint=True) == 2026


# ---------------------------------------------------------------------------
# Thai date parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # Full month names with a 4-digit Buddhist year — what the archive shows.
        ("1 ตุลาคม 2569", date(2026, 10, 1)),
        ("16 กันยายน 2569", date(2026, 9, 16)),
        ("30 ธันวาคม 2549", date(2006, 12, 30)),
        ("2 มกราคม 2568", date(2025, 1, 2)),
        # The dotted abbreviations, with and without a year.
        ("1 พ.ย. 69", date(2026, 11, 1)),
        ("1 ต.ค. 2569", date(2026, 10, 1)),
        ("16 ก.ย. 68", date(2025, 9, 16)),
        # Embedded in the sentence Sanook actually renders.
        ("ตรวจสลากกินแบ่งรัฐบาล ตรวจหวย 1 ตุลาคม 2569", date(2026, 10, 1)),
        # Whitespace variants that a naive parser drops.
        ("1\u00a0ตุลาคม\u00a02569", date(2026, 10, 1)),
        ("  1   ตุลาคม   2569  ", date(2026, 10, 1)),
        # Thai numerals.
        ("๑ ตุลาคม ๒๕๖๙", date(2026, 10, 1)),
        # A Gregorian year is not shifted by 543.
        ("1 มีนาคม 2026", date(2026, 3, 1)),
    ],
)
def test_parse_thai_date_reads_the_forms_the_sources_publish(text: str, expected: date):
    assert parse_thai_date(text) == expected


def test_every_thai_month_parses_in_both_forms():
    """All 12 months, full and abbreviated, with no silent gap."""
    for number, aliases in scraper._THAI_MONTH_ALIASES:
        full, _short, dotted, _plain = aliases
        for token in (full, dotted):
            parsed = parse_thai_date(f"1 {token} 2569")
            assert parsed is not None, f"{token!r} did not parse"
            assert (parsed.year, parsed.month, parsed.day) == (2569 - 543, number, 1)


def test_a_year_less_abbreviation_needs_a_default_year():
    """`1 ต.ค.` is exactly what the archive's visible cell holds — no year at all."""
    assert parse_thai_date("1 ต.ค.") is None
    assert parse_thai_date("1 ต.ค.", default_year=2569) == date(2026, 10, 1)
    assert parse_thai_date("16 พ.ย.", default_year=2568) == date(2025, 11, 16)


def test_a_supplied_year_does_not_override_an_explicit_one():
    assert parse_thai_date("1 ตุลาคม 2569", default_year=2500) == date(2026, 10, 1)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "ตรวจหวย",  # no digits at all
        "1 ตุลาคม",  # day and month, no year, no default -> unresolvable
        "31 กุมภาพันธ์ 2569",  # 31 Feb does not exist
        "0 ตุลาคม 2569",  # day zero
        "1 ไม่มีเดือนนี้ 2569",  # unknown month token
        "2569",  # a bare year
    ],
)
def test_parse_thai_date_returns_none_rather_than_guessing(text: str):
    assert parse_thai_date(text) is None


def test_parse_thai_date_handles_none():
    assert parse_thai_date(None) is None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Number cleaning
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "length", "expected"),
    [
        ("402701", 6, "402701"),
        ("402,701", 6, "402701"),  # thousands separator
        (" 040 123 ", 6, "040123"),  # spaces, leading zero preserved
        ("\u00a0040123\u00a0", 6, "040123"),  # NBSP
        ("70", 2, "70"),
        ("04", 2, "04"),
        ("๕๘", 2, "58"),  # Thai numerals
        ("๐๐", 2, "00"),
    ],
)
def test_clean_number_normalises_and_preserves_leading_zeros(raw, length, expected):
    assert clean_number(raw, length) == expected


@pytest.mark.parametrize(
    ("raw", "length"),
    [
        ("7", 2),  # NOT padded — a 1-digit 2-digit prize is a different number
        ("40270", 6),
        ("4027010", 6),
        ("41", 6),
        ("ABCDEF", 6),
        ("", 6),
        (None, 6),
        ("12.34", 2),  # a decimal point is not a separator we strip
        ("70", 6),
    ],
)
def test_clean_number_rejects_anything_that_is_not_exactly_the_right_width(raw, length):
    assert clean_number(raw, length) is None


def test_validate_draw_refuses_a_malformed_row():
    good = ScrapedDraw("2026-10-01", "402701", "70", "test")
    assert validate_draw(good) is good

    with pytest.raises(scraper.ScrapeError, match="first_prize"):
        validate_draw(ScrapedDraw("2026-10-01", "40270", "70", "test"))
    with pytest.raises(scraper.ScrapeError, match="bottom_two"):
        validate_draw(ScrapedDraw("2026-10-01", "402701", "7", "test"))
    with pytest.raises(scraper.ScrapeError, match="ISO-8601"):
        validate_draw(ScrapedDraw("01/10/2026", "402701", "70", "test"))


def test_as_row_writes_exactly_the_three_table_columns():
    """The table has no `source` column; provenance must not leak into the write."""
    row = ScrapedDraw("2026-10-01", "402701", "70", "sanook-archive").as_row()
    assert row == {"draw_date": "2026-10-01", "first_prize": "402701", "bottom_two": "70"}


# ---------------------------------------------------------------------------
# Archive page parsing against real markup
# ---------------------------------------------------------------------------


def test_archive_page_parses_every_real_draw_block():
    page = parse_sanook_archive_page(fixture("sanook_archive_page1.html"), page=1)
    assert page.skipped == []
    assert len(page.draws) == 21


def test_archive_page_reads_the_documented_first_row():
    page = parse_sanook_archive_page(fixture("sanook_archive_page1.html"), page=1)
    newest = page.draws[0]
    assert newest.draw_date == "2026-10-01"
    assert newest.first_prize == "402701"
    assert newest.bottom_two == "70"  # NOT "01", the trailing digits of the 1st prize
    assert newest.source == "sanook-archive"


def test_archive_draws_are_newest_first_and_well_formed():
    page = parse_sanook_archive_page(fixture("sanook_archive_page1.html"), page=1)
    dates = [draw.draw_date for draw in page.draws]
    assert dates == sorted(dates, reverse=True)
    assert len(dates) == len(set(dates))  # no draw counted twice
    for draw in page.draws:
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", draw.draw_date)
        assert re.fullmatch(r"[0-9]{6}", draw.first_prize)
        assert re.fullmatch(r"[0-9]{2}", draw.bottom_two)


def test_archive_page_reports_the_window_it_covers():
    page = parse_sanook_archive_page(fixture("sanook_archive_page1.html"), page=1)
    assert page.newest == date(2026, 10, 1)
    assert page.oldest == date(2025, 12, 1)


def test_the_archive_captures_draws_moved_off_the_1st_and_16th():
    """The whole reason to read the archive rather than probe a schedule.

    GLO moved the January 2025 draws to the 2nd and the 17th. A 1st/16th probe
    misses both unless it is deliberately widened; the archive simply lists them.
    """
    page = parse_sanook_archive_page(fixture("sanook_archive_page3.html"), page=3)
    by_date = {draw.draw_date: draw for draw in page.draws}

    assert by_date["2025-01-02"].first_prize == "730209"
    assert by_date["2025-01-02"].bottom_two == "51"
    assert by_date["2025-01-17"].first_prize == "807779"
    assert by_date["2025-01-17"].bottom_two == "23"


def test_archive_page_uses_the_machine_readable_datetime_attribute():
    """The ISO `datetime` attribute is the authoritative date signal."""
    html = """
    <article class="archive--lotto">
      <a href="https://news.sanook.com/lotto/check/01102569/">
        <time class="archive--lotto__date" datetime="2026-10-01">1 ต.ค.</time>
        <h3 class="archive--lotto__head-lot">ตรวจหวย 1 ตุลาคม 2569</h3>
        <ul class="archive--lotto__result-list">
          <li><em class="archive--lotto__result-txt">รางวัลที่ 1</em>
              <strong class="archive--lotto__result-number">999999</strong></li>
          <li><em class="archive--lotto__result-txt">เลขท้าย 2 ตัว</em>
              <strong class="archive--lotto__result-number">07</strong></li>
        </ul>
      </a>
    </article>
    """
    page = parse_sanook_archive_page(html, page=1)
    assert page.skipped == []
    assert page.draws[0].draw_date == "2026-10-01"


def test_a_draw_is_still_readable_when_the_year_is_only_in_the_link():
    """`1 ต.ค.` alone is year-less; the link supplies the Buddhist year."""
    html = """
    <article class="archive--lotto">
      <a href="https://news.sanook.com/lotto/check/01102569/">
        <time class="archive--lotto__date">1 ต.ค.</time>
        <ul class="archive--lotto__result-list">
          <li><em class="archive--lotto__result-txt">รางวัลที่ 1</em>
              <strong class="archive--lotto__result-number">402701</strong></li>
          <li><em class="archive--lotto__result-txt">เลขท้าย 2 ตัว</em>
              <strong class="archive--lotto__result-number">70</strong></li>
        </ul>
      </a>
    </article>
    """
    page = parse_sanook_archive_page(html, page=1)
    assert page.skipped == []
    assert page.draws[0].draw_date == "2026-10-01"


def test_the_last_page_is_read_from_the_pagination_links():
    html = """
    <nav>
      <a href="/lotto/archive/page/2/">2</a>
      <a href="/lotto/archive/page/24/">24</a>
    </nav>
    """
    page = parse_sanook_archive_page(html, page=1)
    assert page.last_page == 24
    assert page.draws == []


# ---------------------------------------------------------------------------
# Malformed blocks are skipped, counted and explained — never guessed at
# ---------------------------------------------------------------------------


def _block(
    *,
    first: str | None = "402701",
    last2: str | None = "70",
    iso: str | None = "2026-10-01",
    href: str = "01102569",
    head: str = "ตรวจหวย 1 ตุลาคม 2569",
    cell: str = "1 ต.ค.",
) -> str:
    """Render one draw block, with any field deliberately breakable."""
    time_attr = f' datetime="{iso}"' if iso else ""
    first_cell = (
        f'<li><em class="archive--lotto__result-txt">รางวัลที่ 1</em>'
        f'<strong class="archive--lotto__result-number">{first}</strong></li>'
        if first is not None
        else ""
    )
    last2_cell = (
        f'<li><em class="archive--lotto__result-txt">เลขท้าย 2 ตัว</em>'
        f'<strong class="archive--lotto__result-number">{last2}</strong></li>'
        if last2 is not None
        else ""
    )
    return f"""
    <article class="archive--lotto">
      <a href="https://news.sanook.com/lotto/check/{href}/">
        <time class="archive--lotto__date"{time_attr}>{cell}</time>
        <h3 class="archive--lotto__head-lot">{head}</h3>
        <ul class="archive--lotto__result-list">
          {first_cell}
          <li><em class="archive--lotto__result-txt">เลขหน้า 3 ตัว</em>
              <strong class="archive--lotto__result-number"><span>791</span><span>912</span></strong></li>
          {last2_cell}
        </ul>
      </a>
    </article>
    """


def test_a_5_digit_first_prize_is_skipped_not_padded():
    page = parse_sanook_archive_page(_block(first="40270"), page=7)
    assert page.draws == []
    assert len(page.skipped) == 1
    assert "not 6 digits" in page.skipped[0]
    assert "page 7" in page.skipped[0]


def test_a_1_digit_bottom_two_is_skipped_not_padded():
    page = parse_sanook_archive_page(_block(last2="7"), page=1)
    assert page.draws == []
    assert "not 2 digits" in page.skipped[0]


def test_a_missing_prize_cell_is_skipped():
    page = parse_sanook_archive_page(_block(first=None), page=1)
    assert page.draws == []
    assert "no 'รางวัลที่1' prize cell" in page.skipped[0]

    page = parse_sanook_archive_page(_block(last2=None), page=1)
    assert page.draws == []
    assert "no 'เลขท้าย2ตัว' prize cell" in page.skipped[0]


def test_disagreeing_date_signals_skip_the_row():
    """A page whose own date cells conflict is misaligned, so its row is unsafe."""
    page = parse_sanook_archive_page(_block(iso="2026-10-02"), page=1)
    assert page.draws == []
    assert "date signals disagree" in page.skipped[0]


def test_a_block_with_no_readable_date_is_skipped():
    page = parse_sanook_archive_page(
        _block(iso=None, href="lotto", head="ตรวจหวย", cell="")
    )
    assert page.draws == []
    assert "could not read a draw date" in page.skipped[0]


def test_one_bad_block_does_not_cost_the_good_ones():
    html = _block() + _block(first="40270") + _block(first="123456", cell="16 ก.ย.", href="16092569", head="ตรวจหวย 16 กันยายน 2569", iso="2026-09-16")
    page = parse_sanook_archive_page(html, page=1)
    assert [d.draw_date for d in page.draws] == ["2026-10-01", "2026-09-16"]
    assert len(page.skipped) == 1


def test_a_page_with_no_draw_blocks_yields_nothing_and_skips_nothing():
    """This is how the archive signals "past the end": 200, no blocks, no error."""
    page = parse_sanook_archive_page("<html><body><p>no draws</p></body></html>", page=25)
    assert page.draws == []
    assert page.skipped == []


# ---------------------------------------------------------------------------
# Walking the archive
# ---------------------------------------------------------------------------


def test_collect_walks_pages_until_the_window_is_covered(monkeypatch: pytest.MonkeyPatch):
    """Page 1 spans 2026-10 → 2025-12. Asking for September 2026 stops there.

    The walk must not read page 2: page 1's oldest draw already precedes the
    requested start, which is the signal that the window has been passed.
    """
    page1 = fixture("sanook_archive_page1.html")
    calls: list[str] = []

    def fake_fetch(_session, url, **_kwargs):
        calls.append(url)
        if url.endswith("/lotto/archive/"):
            return page1
        raise AssertionError(f"should not have fetched {url}")

    monkeypatch.setattr(scraper, "fetch_url", fake_fetch)

    collection = scraper.collect_sanook_archive(
        date(2026, 9, 1), date(2026, 10, 1), min_interval=0
    )

    assert [d.draw_date for d in collection.draws] == [
        "2026-10-01",
        "2026-09-16",
        "2026-09-01",
    ]
    assert len(calls) == 1
    assert not collection.failures
    assert not collection.skipped
    # The archive enumerates draws; it never claims a date "had no draw".
    assert collection.missing == []


def test_collect_stops_when_a_page_has_no_blocks(monkeypatch: pytest.MonkeyPatch):
    """Past the end, Sanook answers 200 with an empty body — not a 404."""
    pages = {
        "https://news.sanook.com/lotto/archive/": fixture("sanook_archive_page1.html"),
        "https://news.sanook.com/lotto/archive/page/2/": "<html><body>nothing</body></html>",
    }
    calls: list[str] = []

    def fake_fetch(_session, url, **_kwargs):
        calls.append(url)
        return pages[url]

    monkeypatch.setattr(scraper, "fetch_url", fake_fetch)

    # A window wide enough that only the empty page can stop the walk.
    collection = scraper.collect_sanook_archive(date(2000, 1, 1), date(2030, 1, 1), min_interval=0)

    assert len(collection.draws) == 21
    assert len(calls) == 2
    assert not collection.failures


def test_collect_respects_the_page_cap(monkeypatch: pytest.MonkeyPatch):
    pages = {
        "https://news.sanook.com/lotto/archive/": fixture("sanook_archive_page1.html"),
        "https://news.sanook.com/lotto/archive/page/2/": fixture("sanook_archive_page3.html"),
    }
    calls: list[str] = []

    def fake_fetch(_session, url, **_kwargs):
        calls.append(url)
        return pages[url]

    monkeypatch.setattr(scraper, "fetch_url", fake_fetch)

    collection = scraper.collect_sanook_archive(
        date(2000, 1, 1), date(2030, 1, 1), max_pages=2, min_interval=0
    )
    assert len(collection.draws) == 41
    assert len(calls) == 2


def test_collect_records_a_request_failure_without_raising(monkeypatch: pytest.MonkeyPatch):
    def failing_fetch(_session, url, **_kwargs):
        raise scraper.ScrapeError(f"boom: {url}")

    monkeypatch.setattr(scraper, "fetch_url", failing_fetch)

    collection = scraper.collect_sanook_archive(date(2026, 1, 1), date(2026, 10, 1), min_interval=0)
    assert collection.draws == []
    assert len(collection.failures) == 1
    assert "boom" in collection.failures[0][1]


# ---------------------------------------------------------------------------
# Myhora: the independent second archive, used to fill Sanook's holes
# ---------------------------------------------------------------------------


def test_myhora_url_addresses_the_draw_in_the_buddhist_era():
    assert myhora_url(date(2007, 12, 1)) == (
        "https://myhora.com/lottery/result-01-12-2550.aspx"
    )
    assert myhora_url(date(2026, 10, 1)) == (
        "https://myhora.com/lottery/result-01-10-2569.aspx"
    )


def test_myhora_parses_the_draw_sanook_omits():
    """2007-12-01: the one draw genuinely missing from the Sanook archive."""
    draw = parse_myhora_html(fixture("myhora_2007-12-01.html"), date(2007, 12, 1))
    assert draw is not None
    assert draw.draw_date == "2007-12-01"
    assert draw.first_prize == "113410"
    assert draw.bottom_two == "18"
    assert draw.source == "myhora"


def test_myhora_is_not_fooled_by_the_neighbouring_draws_sidebar():
    """The trap a live run hit: the page carries six result blocks, and the last
    2-digit cell on it (``88``) belongs to a *different* draw. Reading the prize
    positionally produced 88 and was correctly rejected; the answer is 18.

    The fixture is the real page with all six blocks, so this cannot regress into
    passing on a tidied-up imitation.
    """
    html = fixture("myhora_2007-12-01.html")
    assert html.count('class="lot-dr"') == 6
    assert ">88<" in html  # the neighbouring draw's 2-digit prize

    draw = parse_myhora_html(html, date(2007, 12, 1))
    assert draw is not None
    assert draw.bottom_two == "18"
    assert draw.first_prize == "113410"


def test_myhora_parses_a_modern_draw_too():
    """The same parser against a 2026 page — the markup has not drifted."""
    draw = parse_myhora_html(fixture("myhora_2026-10-01.html"), date(2026, 10, 1))
    assert draw is not None
    assert draw.draw_date == "2026-10-01"
    assert draw.first_prize == "402701"
    assert draw.bottom_two == "70"


def test_myhora_no_draw_page_returns_none_not_a_row():
    """Verified against dates GLO confirms had no draw (the 2020 suspensions).

    Myhora answers those with HTTP 200 and an empty shell. Reading that as a draw,
    or as a parse failure, would both be wrong: the date simply has no draw.
    """
    html = (
        '<html><head><title>- myhora.com</title>'
        '<meta name="Description" content=""/></head><body>'
        '<div class="lot-dr"><div class="lot-dc"></div>'
        '<div class="lot-dc"></div></div></body></html>'
    )
    assert parse_myhora_html(html, date(2020, 4, 16)) is None


def test_myhora_refuses_a_page_describing_a_different_draw():
    with pytest.raises(scraper.ScrapeError, match="reports 2007-12-01"):
        parse_myhora_html(fixture("myhora_2007-12-01.html"), date(2007, 12, 16))


def test_myhora_raises_when_a_result_page_states_no_date():
    html = (
        '<html><head><meta name="Description" content="รางวัลที่ 1 (113410)"/></head>'
        '<body><div class="lot-dr"><div class="lot-dc">113410</div></div></body></html>'
    )
    with pytest.raises(scraper.ScrapeError, match="states no readable draw date"):
        parse_myhora_html(html, date(2007, 12, 1))


def test_myhora_raises_when_the_description_lacks_a_prize():
    html = (
        '<html><head><title>ตรวจหวย งวด 1 ธันวาคม 2550</title>'
        '<meta name="Description" content="ตรวจหวย"/></head><body>'
        '<div class="lot-dr"><div class="lot-dc">113410</div>'
        '<div class="lot-dc">18</div></div></body></html>'
    )
    with pytest.raises(scraper.ScrapeError, match="does not carry both prizes"):
        parse_myhora_html(html, date(2007, 12, 1))


def test_myhora_raises_when_no_block_carries_the_described_draw():
    """The meta description and the visible blocks are cross-checked."""
    html = (
        '<html><head><title>ตรวจหวย งวด 1 ธันวาคม 2550</title>'
        '<meta name="Description" content="รางวัลที่ 1 (113410) เลขท้าย 2 ตัว(18)"/>'
        '</head><body><div class="lot-dr">'
        '<div class="lot-dc">999999</div><div class="lot-dc">18</div>'
        '</div></body></html>'
    )
    with pytest.raises(scraper.ScrapeError, match="no result block carries 113410/18"):
        parse_myhora_html(html, date(2007, 12, 1))


def test_myhora_still_accepts_a_page_whose_featured_block_comes_first():
    """Cross-checking must not be so strict that an ordinary page fails."""
    html = (
        '<html><head><title>ตรวจหวย งวด 1 ธันวาคม 2550</title>'
        '<meta name="Description" content="รางวัลที่ 1 (113410) เลขท้าย 2 ตัว(18)"/>'
        '</head><body>'
        '<div class="lot-dr"><div class="lot-dc">513501</div>'
        '<div class="lot-dc">96</div></div>'
        '<div class="lot-dr"><div class="lot-dc">113410</div>'
        '<div class="lot-dc">418 485 627 659</div>'
        '<div class="lot-dc">18</div></div>'
        '</body></html>'
    )
    draw = parse_myhora_html(html, date(2007, 12, 1))
    assert draw is not None and draw.bottom_two == "18"


def test_collect_myhora_isolates_a_failure(monkeypatch: pytest.MonkeyPatch):
    def fake_fetch(_session, url, **_kwargs):
        if url.endswith("result-01-12-2550.aspx"):
            return fixture("myhora_2007-12-01.html")
        raise scraper.ScrapeError(f"boom: {url}")

    monkeypatch.setattr(scraper, "fetch_url", fake_fetch)

    collection = scraper.collect_myhora(
        [date(2007, 12, 1), date(2007, 12, 2)], min_interval=0
    )
    assert [d.draw_date for d in collection.draws] == ["2007-12-01"]
    assert len(collection.failures) == 1


# ---------------------------------------------------------------------------
# Gap detection: inferring where a draw is missing
# ---------------------------------------------------------------------------


def _draws_on(dates: list[str]) -> list[ScrapedDraw]:
    """One draw per date, with a distinct prize pair so the duplicate guard stays out of the way."""
    return [
        ScrapedDraw(d, f"{index + 1:06d}", f"{index:02d}", "sanook-archive")
        for index, d in enumerate(dates)
    ]


def test_gap_detection_finds_the_real_2007_hole():
    """The archive jumps 2007-11-16 -> 2007-12-16 and omits 1 December."""
    candidates = find_missing_draw_dates(
        _draws_on(["2007-11-01", "2007-11-16", "2007-12-16", "2008-01-01"])
    )
    assert candidates == [date(2007, 12, 1), date(2007, 12, 2)]


def test_gap_detection_flags_the_covid_window():
    """2020-04-01 -> 2020-06-01 is a real absence; it is still worth probing."""
    candidates = find_missing_draw_dates(
        _draws_on(["2020-03-16", "2020-04-01", "2020-06-01", "2020-06-16"])
    )
    assert candidates == [
        date(2020, 4, 16),
        date(2020, 4, 17),
        date(2020, 5, 1),
        date(2020, 5, 2),
        date(2020, 5, 16),
        date(2020, 5, 17),
    ]


def test_gap_detection_never_offers_the_day_after_a_collected_draw():
    """A one-day move replaces its slot, so 17 Nov cannot be a second draw
    when 16 Nov is already held — only 1 December can."""
    candidates = find_missing_draw_dates(
        _draws_on(["2007-11-01", "2007-11-16", "2007-12-16", "2008-01-01"])
    )
    assert date(2007, 11, 17) not in candidates
    assert date(2007, 12, 17) not in candidates
    assert date(2007, 11, 30) not in candidates  # the 30th is a December draw only


def test_gap_detection_is_silent_on_normal_spacing():
    """Ordinary gaps are 12-18 days; none of them may trigger a probe.

    This is the real 2025-12 -> 2026-03 sequence from the archive, including the
    New Year move to 30 December and the January move to the 2nd, none of which
    may be mistaken for a hole.
    """
    dates = [
        "2025-12-01", "2025-12-16", "2025-12-30", "2026-01-02", "2026-01-17",
        "2026-02-01", "2026-02-16", "2026-03-01",
    ]
    assert find_missing_draw_dates(_draws_on(dates)) == []


def test_gap_detection_only_offers_days_glo_actually_draws_on():
    candidates = find_missing_draw_dates(
        _draws_on(["2007-11-16", "2007-12-16"])
    )
    assert candidates, "a 30-day gap must produce candidates"
    assert all(d.day in scraper.DRAW_DAY_CANDIDATES for d in candidates)
    assert (date(2007, 12, 16) - min(candidates)).days <= 16


def test_gap_detection_ignores_an_empty_or_single_draw_history():
    assert find_missing_draw_dates([]) == []
    assert find_missing_draw_dates(_draws_on(["2026-10-01"])) == []


def test_gap_detection_is_order_independent():
    """The archive yields newest-first; detection must not depend on that."""
    newest_first = _draws_on(["2007-12-16", "2007-11-16", "2007-11-01"])
    assert find_missing_draw_dates(newest_first) == [date(2007, 12, 1), date(2007, 12, 2)]


def test_archive_url_shape():
    assert scraper.sanook_archive_url(1) == "https://news.sanook.com/lotto/archive/"
    assert scraper.sanook_archive_url(2) == "https://news.sanook.com/lotto/archive/page/2/"


# ---------------------------------------------------------------------------
# Window defaults
# ---------------------------------------------------------------------------


def test_years_before_covers_a_full_calendar_decade():
    """3650 days is ~10 days short of 10 years; the requirement is "at least"."""
    today = date(2026, 10, 13)
    start = years_before(today, 10)
    assert start == date(2016, 10, 13)
    assert (today - start).days > 3650


def test_years_before_clamps_a_leap_day():
    assert years_before(date(2024, 2, 29), 1) == date(2023, 2, 28)


def test_the_default_window_reaches_back_ten_years_and_a_margin():
    args = scraper._build_parser().parse_args([])
    start, end = scraper._resolve_window(args)
    assert end == date.today()
    assert start == years_before(date.today(), 10) - timedelta(
        days=scraper.DEFAULT_BACKFILL_MARGIN_DAYS
    )


def test_a_bare_ten_year_window_would_not_yield_ten_years_of_data():
    """Why the margin exists, stated as the property it guarantees.

    Draws are ~15 days apart, so a window opening the day after a draw collects
    its first draw a fortnight later. Measured against the live archive, the
    bare window gave 2016-10-16 -> 2026-10-01 = 9.96 years of data. With the
    margin, even the worst gap ever observed (45 days, the 2020 COVID
    suspension) still leaves a full decade.
    """
    today = date(2026, 10, 13)
    bare_start = years_before(today, 10)
    widened_start = bare_start - timedelta(days=scraper.DEFAULT_BACKFILL_MARGIN_DAYS)

    # Worst case: the window opens immediately after a draw, so the first draw
    # inside it sits one full maximum-gap later.
    first_draw_worst_case = widened_start + timedelta(
        days=scraper.DEFAULT_BACKFILL_MARGIN_DAYS
    )
    assert first_draw_worst_case <= bare_start
    assert (today - first_draw_worst_case).days >= (today - bare_start).days

    # The measured real case: the bare window loses ~3 days, the widened one does not.
    bare_span = (date(2026, 10, 1) - (bare_start + timedelta(days=3))).days / 365.25
    assert bare_span < 10  # the defect the margin fixes
    assert widened_start < bare_start


# ---------------------------------------------------------------------------
# Ingestion bookkeeping
# ---------------------------------------------------------------------------


def test_dedupe_collapses_a_repeated_draw_date():
    """PostgreSQL rejects one upsert statement touching a conflict target twice."""
    rows = [
        {"draw_date": "2026-10-01", "first_prize": "111111", "bottom_two": "11"},
        {"draw_date": "2026-10-01", "first_prize": "222222", "bottom_two": "22"},
        {"draw_date": "2026-09-16", "first_prize": "333333", "bottom_two": "33"},
    ]
    deduped, dropped = scraper.dedupe(rows)
    assert dropped == 1
    assert len(deduped) == 2
    # Sorted by draw_date, so the surviving 2026-10-01 row is the second one and
    # it holds the LAST value seen for that date.
    assert [r["draw_date"] for r in deduped] == ["2026-09-16", "2026-10-01"]
    assert deduped[1]["first_prize"] == "222222"  # last write wins


def test_the_real_stale_2020_05_16_page_is_dropped():
    """The exact defect found by checking a live 10-year scrape against GLO.

    Sanook serves a 2020-05-16 page carrying the 2020-04-01 draw's numbers, but
    GLO confirms no draw happened on 2020-05-16 (COVID suspended the 16 April and
    2 May 2020 draws). Writing it would invent a draw.
    """
    draws = [
        ScrapedDraw("2020-03-16", "503446", "77", "sanook-archive"),
        ScrapedDraw("2020-04-01", "051095", "22", "sanook-archive"),  # real
        ScrapedDraw("2020-05-16", "051095", "22", "sanook-archive"),  # stale page
        ScrapedDraw("2020-06-01", "831567", "24", "sanook-archive"),
    ]
    kept, skipped = scraper.drop_repeated_prize_pairs(draws)

    assert [d.draw_date for d in kept] == ["2020-03-16", "2020-04-01", "2020-06-01"]
    assert len(skipped) == 1
    assert "2020-05-16" in skipped[0] and "2020-04-01" in skipped[0]
    assert "051095/22" in skipped[0]


def test_the_earliest_date_wins_regardless_of_input_order():
    """The archive yields newest-first; the guard must still keep the earlier date."""
    newer_first = [
        ScrapedDraw("2020-05-16", "051095", "22", "sanook-archive"),
        ScrapedDraw("2020-04-01", "051095", "22", "sanook-archive"),
    ]
    kept, skipped = scraper.drop_repeated_prize_pairs(newer_first)
    assert [d.draw_date for d in kept] == ["2020-04-01"]
    assert len(skipped) == 1


def test_distinct_prize_pairs_are_all_kept():
    draws = [
        ScrapedDraw("2026-09-01", "417212", "04", "sanook-archive"),
        ScrapedDraw("2026-09-16", "730640", "64", "sanook-archive"),
        ScrapedDraw("2026-10-01", "402701", "70", "sanook-archive"),
    ]
    kept, skipped = scraper.drop_repeated_prize_pairs(draws)
    assert kept == sorted(draws, key=lambda d: d.draw_date)
    assert skipped == []


def test_a_prize_pair_repeated_thrice_keeps_only_the_first():
    draws = [
        ScrapedDraw("2020-04-01", "051095", "22", "sanook-archive"),
        ScrapedDraw("2020-05-16", "051095", "22", "sanook-archive"),
        ScrapedDraw("2020-06-01", "051095", "22", "sanook-archive"),
    ]
    kept, skipped = scraper.drop_repeated_prize_pairs(draws)
    assert [d.draw_date for d in kept] == ["2020-04-01"]
    assert len(skipped) == 2


def test_a_shared_first_prize_with_a_different_2_digit_prize_is_not_a_duplicate():
    """Only the full pair is treated as a repeat, not the first prize alone."""
    draws = [
        ScrapedDraw("2020-04-01", "051095", "22", "sanook-archive"),
        ScrapedDraw("2020-06-01", "051095", "24", "sanook-archive"),
    ]
    kept, skipped = scraper.drop_repeated_prize_pairs(draws)
    assert len(kept) == 2
    assert skipped == []


class _FakeTable:
    def __init__(self, recorder: list):
        self.recorder = recorder

    def upsert(self, batch, on_conflict=None):
        self.recorder.append((list(batch), on_conflict))
        return self

    def execute(self):
        return type("Response", (), {"data": None})()  # PostgREST sent no representation


class _FakeClient:
    def __init__(self):
        self.calls: list = []

    def table(self, name):
        assert name == "lottery_draws"
        return _FakeTable(self.calls)


def test_upsert_targets_the_type_and_date_pair_and_batches():
    client = _FakeClient()
    rows = [
        {"draw_date": f"2026-01-{day:02d}", "first_prize": "123456", "bottom_two": "12"}
        for day in range(1, 6)
    ]
    written = scraper.upsert_rows(client, rows, batch_size=2)

    assert [len(batch) for batch, _ in client.calls] == [2, 2, 1]
    # The pair, not `draw_date` alone: it has to match the unique key in
    # schema.sql, and a date-only target would let another country's draw on the
    # same date overwrite this one.
    assert {target for _, target in client.calls} == {"lottery_type,draw_date"}
    # No representation came back, but the rows were still sent and counted.
    assert written == 5


def test_upsert_of_nothing_writes_nothing():
    client = _FakeClient()
    assert scraper.upsert_rows(client, []) == 0
    assert client.calls == []


# ---------------------------------------------------------------------------
# CLI end to end (dry run, no network, no database)
# ---------------------------------------------------------------------------


def test_dry_run_reports_coverage_and_never_touches_supabase(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    caplog.set_level(logging.INFO)
    draws = [
        ScrapedDraw("2026-09-01", "417212", "04", "sanook-archive"),
        ScrapedDraw("2026-09-16", "730640", "64", "sanook-archive"),
        ScrapedDraw("2026-10-01", "402701", "70", "sanook-archive"),
    ]
    monkeypatch.setattr(
        scraper,
        "_collect",
        lambda *_a, **_k: Collection(draws=draws, missing=[], failures=[], skipped=[]),
    )

    def explode():
        raise AssertionError("--dry-run must not create a Supabase client")

    monkeypatch.setattr(scraper, "create_supabase_client", explode)

    out = tmp_path / "rows.json"
    code = scraper.main(
        ["--source", "archive", "--from", "2026-09-01", "--to", "2026-10-01", "--dry-run",
         "--json-out", str(out)]
    )

    assert code == 0
    assert "DRY RUN" in caplog.text
    assert out.exists()
    rows = json.loads(out.read_text(encoding="utf-8"))
    assert rows == [
        {"draw_date": "2026-09-01", "first_prize": "417212", "bottom_two": "04"},
        {"draw_date": "2026-09-16", "first_prize": "730640", "bottom_two": "64"},
        {"draw_date": "2026-10-01", "first_prize": "402701", "bottom_two": "70"},
    ]
    # The `source` metadata must never reach the table.
    assert all(set(row) == {"draw_date", "first_prize", "bottom_two"} for row in rows)


def test_latest_keeps_only_the_newest_draw(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    caplog.set_level(logging.INFO)
    draws = [
        ScrapedDraw("2026-09-01", "417212", "04", "sanook-archive"),
        ScrapedDraw("2026-09-16", "730640", "64", "sanook-archive"),
        ScrapedDraw("2026-10-01", "402701", "70", "sanook-archive"),
    ]
    monkeypatch.setattr(
        scraper,
        "_collect",
        lambda *_a, **_k: Collection(draws=draws, missing=[], failures=[], skipped=[]),
    )

    out = tmp_path / "latest.json"
    code = scraper.main(["--source", "archive", "--latest", "--dry-run", "--json-out", str(out)])

    assert code == 0
    assert json.loads(out.read_text(encoding="utf-8")) == [
        {"draw_date": "2026-10-01", "first_prize": "402701", "bottom_two": "70"}
    ]


def test_the_guard_is_wired_into_the_cli(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    """The duplicate guard must run on the real path, not just in isolation."""
    caplog.set_level(logging.INFO)
    draws = [
        ScrapedDraw("2020-04-01", "051095", "22", "sanook-archive"),
        ScrapedDraw("2020-05-16", "051095", "22", "sanook-archive"),
        ScrapedDraw("2020-06-01", "831567", "24", "sanook-archive"),
    ]
    monkeypatch.setattr(
        scraper,
        "_collect",
        lambda *_a, **_k: Collection(draws=draws, missing=[], failures=[], skipped=[]),
    )

    out = tmp_path / "rows.json"
    code = scraper.main(["--source", "archive", "--dry-run", "--json-out", str(out)])

    assert code == 0
    rows = json.loads(out.read_text(encoding="utf-8"))
    assert [r["draw_date"] for r in rows] == ["2020-04-01", "2020-06-01"]
    assert "1 row(s) skipped" in caplog.text


def _archive_with_a_hole() -> Collection:
    """The real 2007-12-01 hole, as the archive actually delivers it."""
    return Collection(
        draws=_draws_on(["2007-11-16", "2007-12-16", "2008-01-01"]),
        missing=[],
        failures=[],
        skipped=[],
    )


def test_fill_gaps_recovers_the_draw_the_archive_omits(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(scraper, "_collect", lambda *_a, **_k: _archive_with_a_hole())
    monkeypatch.setattr(
        scraper,
        "collect_myhora",
        lambda dates, **_k: Collection(
            draws=[
                ScrapedDraw(d.isoformat(), "113410", "18", "myhora") for d in dates if d == date(2007, 12, 1)
            ],
            missing=[d.isoformat() for d in dates if d != date(2007, 12, 1)],
            failures=[],
            skipped=[],
        ),
    )

    out = tmp_path / "rows.json"
    code = scraper.main(
        ["--source", "archive", "--fill-gaps", "--dry-run", "--json-out", str(out)]
    )

    assert code == 0
    rows = json.loads(out.read_text(encoding="utf-8"))
    assert "2007-12-01" in [r["draw_date"] for r in rows]
    assert [r for r in rows if r["draw_date"] == "2007-12-01"] == [
        {"draw_date": "2007-12-01", "first_prize": "113410", "bottom_two": "18"}
    ]
    assert "Gap fill: recovered 1 draw(s)" in caplog.text


def test_fill_gaps_is_off_by_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """A routine refresh should not pay for a second source."""
    monkeypatch.setattr(scraper, "_collect", lambda *_a, **_k: _archive_with_a_hole())

    def explode(_dates, **_kwargs):
        raise AssertionError("--fill-gaps was not asked for")

    monkeypatch.setattr(scraper, "collect_myhora", explode)

    out = tmp_path / "rows.json"
    code = scraper.main(["--source", "archive", "--dry-run", "--json-out", str(out)])

    assert code == 0
    assert "2007-12-01" not in [r["draw_date"] for r in json.loads(out.read_text("utf-8"))]


def test_fill_gaps_says_so_when_there_is_nothing_to_fill(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(
        scraper,
        "_collect",
        lambda *_a, **_k: Collection(
            draws=_draws_on(["2026-09-01", "2026-09-16", "2026-10-01"]),
            missing=[],
            failures=[],
            skipped=[],
        ),
    )
    monkeypatch.setattr(
        scraper, "collect_myhora", lambda *_a, **_k: pytest.fail("nothing should be probed")
    )

    assert scraper.main(["--source", "archive", "--fill-gaps", "--dry-run"]) == 0
    assert "no gaps in the collected spacing" in caplog.text


def test_the_empty_tail_page_does_not_inflate_the_advertised_page_count(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Past the end Sanook returns a shell whose pager still links to itself."""
    caplog.set_level(logging.INFO)
    page1 = fixture("sanook_archive_page1.html").replace(
        "</body>",
        '<nav><a href="/lotto/archive/page/2/">2</a>'
        '<a href="/lotto/archive/page/24/">24</a></nav></body>',
    )
    page2 = '<html><body><nav><a href="/lotto/archive/page/25/">25</a></nav></body></html>'
    pages = {
        "https://news.sanook.com/lotto/archive/": page1,
        "https://news.sanook.com/lotto/archive/page/2/": page2,
    }
    monkeypatch.setattr(scraper, "fetch_url", lambda _s, url, **_k: pages[url])

    collection = scraper.collect_sanook_archive(date(2000, 1, 1), date(2030, 1, 1), min_interval=0)

    assert len(collection.draws) == 21
    assert "advertises 24 page(s)" in caplog.text
    assert "advertises 25" not in caplog.text


def test_no_draws_collected_exits_non_zero(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        scraper,
        "_collect",
        lambda *_a, **_k: Collection(draws=[], missing=[], failures=[], skipped=[]),
    )
    assert scraper.main(["--source", "archive", "--dry-run"]) == 1
