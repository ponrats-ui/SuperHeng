"""Tests for `accuracy.py` and `GET /api/premium/accuracy-report`.

Three levels, kept apart on purpose:

* **Pure**: `accuracy.build_report` over hand-built rows. No client, no database —
  the module takes rows rather than fetching them precisely so this is possible.
* **The leakage property**, which gets its own section because it is the one thing
  that would make every number in the report a lie while still looking plausible.
  The model must be handed the draws strictly before its target and nothing else;
  it is asserted by spying on the rows the model actually receives, not by reading
  the slicing code.
* **HTTP**: the real route, through the real entitlement gate, with only the two
  Supabase seams stubbed — the same approach `test_auth.py` and `test_bayesian.py`
  take.

The ledger in most tests is deliberately constant (`111111` every draw), because it
makes the expected answer computable by hand: a digit seen in one position in every
historical draw must be that position's top pick, so a hit is a fact rather than a
coincidence of the seed.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import accuracy
import auth
import backtest
import main
import models.bayesian
import services
from conftest import grant_premium

USER_ID = "11111111-1111-4111-8111-111111111111"

POSITION_NAMES = [
    "hundred_thousands",
    "ten_thousands",
    "thousands",
    "hundreds",
    "tens",
    "units",
]

VIETNAM_POSITION_NAMES = ["ten_thousands", "thousands", "hundreds", "tens", "units"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def ledger(count: int, *, prize: str = "111111", bottom: str = "11", tail: str | None = None):
    """``count`` draws, oldest first, with unique dates and a constant prize.

    ``tail`` replaces the final draw's first prize, which is how a "the model had
    never seen this digit" case is built: the history is uniform and the draw under
    test breaks it.
    """
    rows = []
    for index in range(count):
        rows.append(
            {
                "draw_date": f"{2000 + index // 12:04d}-{1 + index % 12:02d}-01",
                "first_prize": prize,
                "bottom_two": bottom,
            }
        )
    # The final row's date has to stay unique and chronological, so it is placed a
    # month after the last one rather than overwriting it.
    if tail is not None:
        last = rows[-1]["draw_date"]
        year, month, _day = (int(part) for part in last.split("-"))
        month += 1
        if month > 12:
            month, year = 1, year + 1
        rows.append(
            {
                "draw_date": f"{year:04d}-{month:02d}-01",
                "first_prize": tail,
                "bottom_two": bottom,
            }
        )
    return rows


def report(rows, **kwargs):
    """Shorthand for the common call, with the positional length inferred."""
    options = {"train_window": 400, "prize_digits": 6}
    options.update(kwargs)
    return accuracy.build_report(rows, **options)


def scored_blocks(payload):
    """Every rate in the payload that must carry a baseline, as ``(name, block)``."""
    blocks = [("positional.overall", payload["accuracy"]["positional"]["overall"])]
    for name, block in payload["accuracy"]["positional"]["positions"].items():
        blocks.append((f"positional.{name}", block))
    for channel, block in payload["accuracy"]["channels"].items():
        if not block.get("available"):
            continue
        blocks.append((f"channel.{channel}.exact", block["exact"]))
        blocks.append((f"channel.{channel}.in_top_5", block["in_top_5"]))
    return blocks


# ---------------------------------------------------------------------------
# Pure: the comparison itself
# ---------------------------------------------------------------------------
def test_a_digit_seen_in_every_historical_draw_is_predicted_for_the_next_one():
    """The obvious case, and the one that proves the plumbing end to end: a constant
    history of `1`s must produce `1` as every position's top pick, so a draw of
    `111111` is six hits — not "whatever the model happened to say"."""
    payload = report(ledger(60), draws=1)

    latest = payload["comparisons"][0]
    assert latest["first_prize"] == "111111"
    assert latest["position_predictions"] == 6
    assert latest["position_hits"] == 6

    for entry in latest["positions"]:
        assert entry["predicted"] == "1"
        assert entry["actual"] == "1"
        assert entry["hit"] is True
        assert entry["actual_rank"] == 1
        assert entry["in_top"] is True


def test_a_draw_that_breaks_the_pattern_is_reported_as_a_miss():
    """No softening: the history is all `1`s and the draw is all `9`s, so this is six
    misses, and the payload must say so rather than omitting the rows or scoring the
    near-misses as hits."""
    payload = report(ledger(60, tail="999999"), draws=1)

    latest = payload["comparisons"][0]
    assert latest["first_prize"] == "999999"
    assert latest["position_hits"] == 0

    for entry in latest["positions"]:
        assert entry["predicted"] == "1"
        assert entry["actual"] == "9"
        assert entry["hit"] is False


def test_hit_and_rank_are_the_same_fact_stated_twice():
    """`hit` is `actual_rank == 1`, and `in_top` is `actual_rank is not None`. Pinned
    as a property across a randomised ledger, because the two are computed from
    separate expressions and a divergence would let the UI colour a miss green."""
    import random

    rng = random.Random(20261016)
    rows = [
        {
            "draw_date": f"{2000 + index // 12:04d}-{1 + index % 12:02d}-01",
            "first_prize": "".join(rng.choice("0123456789") for _ in range(6)),
            "bottom_two": f"{rng.randrange(100):02d}",
        }
        for index in range(120)
    ]

    payload = report(rows, draws=6)
    assert payload["comparisons"]

    checked = 0
    for comparison in payload["comparisons"]:
        for entry in comparison["positions"]:
            assert entry["hit"] == (entry["actual_rank"] == 1)
            assert entry["in_top"] == (entry["actual_rank"] is not None)
            assert entry["hit"] == (entry["predicted"] == entry["actual"])
            if entry["actual_rank"] is not None:
                assert 1 <= entry["actual_rank"] <= len(entry["top"])
            checked += 1
    assert checked >= 30


def test_the_predicted_digit_is_the_first_of_the_top_three():
    """The side-by-side UI reads `predicted` for the AI column and `top` for the
    ranking, so the two must agree — a `predicted` that is not the top pick would
    render one digit and colour another."""
    payload = report(ledger(60), draws=2)

    for comparison in payload["comparisons"]:
        for entry in comparison["positions"]:
            assert entry["top"]
            assert entry["predicted"] == entry["top"][0]["digit"]
            assert len(entry["top"]) <= 3


def test_positions_are_ordered_left_to_right():
    """`index` 0 is the leading digit, and the card renders this list in order."""
    payload = report(ledger(60), draws=1)

    positions = payload["comparisons"][0]["positions"]
    assert [entry["name"] for entry in positions] == POSITION_NAMES
    assert [entry["index"] for entry in positions] == [0, 1, 2, 3, 4, 5]
    # The `actual` digit is the prize's digit at that position — the whole point of
    # the comparison.
    for entry in positions:
        assert entry["actual"] == "111111"[entry["index"]]


def test_a_five_digit_ledger_reports_five_positions_and_no_top_channel():
    """Vietnam's giải đặc biệt is five digits. Five positions and an unavailable 'top'
    channel is the structural truth, not missing data, and it must be reported as
    unavailable with a reason rather than scored as a miss."""
    rows = [
        {
            "draw_date": row["draw_date"],
            "first_prize": row["first_prize"][:5],
            "bottom_two": row["bottom_two"],
        }
        for row in ledger(60, prize="11111")
    ]

    payload = report(rows, draws=1, prize_digits=5, lottery_type="vietnam")

    latest = payload["comparisons"][0]
    assert [entry["name"] for entry in latest["positions"]] == VIETNAM_POSITION_NAMES
    assert latest["position_hits"] == 5

    top = payload["accuracy"]["channels"]["top"]
    assert top["available"] is False
    assert "five digits" in top["reason"]
    # The bottom channel is unaffected: it is a published 2-digit prize.
    assert payload["accuracy"]["channels"]["bottom"]["available"] is True
    assert latest["top_two"] is None


def test_the_channels_are_scored_exactly_and_inside_the_top_five():
    payload = report(ledger(60, prize="111111", bottom="11"), draws=2)

    latest = payload["comparisons"][0]
    for channel in services.CHANNELS:
        entry = latest["channels"][channel]
        assert entry["available"] is True
        assert entry["picks"] and len(entry["picks"]) == backtest.DEFAULT_TOP_K
        assert entry["exact_hit"] == (entry["predicted"] == entry["actual"])
        assert entry["in_top_5"] == (entry["actual"] in entry["picks"])

    bottom = payload["accuracy"]["channels"]["bottom"]
    assert bottom["draws"] == 2
    assert bottom["picks_per_draw"] == backtest.DEFAULT_TOP_K


# ---------------------------------------------------------------------------
# Pure: the statistics and the honesty rules
# ---------------------------------------------------------------------------
def test_every_rate_is_published_with_the_baseline_it_must_beat():
    """The project's rule, asserted structurally: no rate leaves this payload without
    its baseline, lift, p-value and the sample it rests on."""
    payload = report(ledger(60), draws=3)

    blocks = scored_blocks(payload)
    assert len(blocks) >= 8  # 6 positions + overall + 2 channels × 2 strategies

    for name, block in blocks:
        assert block["predictions"] > 0, name
        assert block["hit_rate_percent"] is not None, name
        assert block["baseline_percent"] > 0, name
        assert block["lift_vs_uniform"] is not None, name
        assert 0.0 <= block["p_value"] <= 1.0, name
        assert isinstance(block["significant"], bool), name
        assert block["alpha"] == backtest.SIGNIFICANCE_ALPHA, name

    for name, block in payload["accuracy"]["positional"]["positions"].items():
        assert block["baseline_percent"] == pytest.approx(100 * backtest.UNIFORM_DIGIT_RATE)


def test_the_positional_baseline_is_one_digit_in_one_position():
    """10% — not 1%, and not the 1-in-a-million of a whole ticket. Getting this wrong
    would make the model look either terrible or miraculous."""
    payload = report(ledger(60), draws=2)

    assert payload["accuracy"]["positional"]["overall"]["baseline_percent"] == 10.0
    assert payload["accuracy"]["channels"]["bottom"]["exact"]["baseline_percent"] == 1.0
    assert payload["accuracy"]["channels"]["bottom"]["in_top_5"]["baseline_percent"] == 5.0


def test_the_p_value_is_the_same_binomial_tail_the_backtest_publishes():
    """One statistic in the codebase, not two: this report must not grow its own
    definition of "better than chance" and then disagree with `/api/backtest`."""
    payload = report(ledger(60), draws=2)
    overall = payload["accuracy"]["positional"]["overall"]

    expected = backtest.binomial_tail(
        overall["hits"], overall["predictions"], backtest.UNIFORM_DIGIT_RATE
    )
    assert overall["p_value"] == round(expected, 4)
    assert overall["significant"] == (expected < backtest.SIGNIFICANCE_ALPHA)


def test_a_perfect_run_of_six_is_significant_and_the_caveat_says_why_that_is_weak():
    """Six of six hits against a 10% baseline is p ≈ 1e-6, so the honest verdict is
    "significant" — a green headline is not softened into a hedge. What keeps that
    from being a claim of skill is the published caveat: the p-values are not
    corrected for the six positions and four channel strategies compared at the same
    time, so roughly one in twenty uncorrected results clears 0.05 by chance alone.
    """
    payload = report(ledger(60), draws=1)

    overall = payload["accuracy"]["positional"]["overall"]
    assert overall["hits"] == overall["predictions"] == 6
    assert overall["hit_rate_percent"] == 100.0
    assert overall["significant"] is True
    assert overall["hits_needed"] is not None

    limitations = " ".join(payload["limitations"])
    assert "not" in limitations and "corrected" in limitations
    assert "six positions" in limitations


def test_the_verdict_and_the_warning_always_agree():
    """The prose warning is emitted exactly when the p-value cannot separate the model
    from chance. A report that printed "indistinguishable from chance" beside a
    significant flag would be contradicting itself on one screen."""
    import random

    rng = random.Random(11)
    rows = [
        {
            "draw_date": f"{2000 + index // 12:04d}-{1 + index % 12:02d}-01",
            "first_prize": "".join(rng.choice("0123456789") for _ in range(6)),
            "bottom_two": f"{rng.randrange(100):02d}",
        }
        for index in range(120)
    ]

    payload = report(rows, draws=5)
    overall = payload["accuracy"]["positional"]["overall"]
    hedged = any("indistinguishable from chance" in warning for warning in payload["warnings"])

    assert hedged == (not overall["significant"])


def test_the_positional_aggregate_equals_the_sum_over_the_draws():
    """The aggregate is derived from the same rows the per-draw section shows, so the
    headline can never disagree with the list below it."""
    import random

    rng = random.Random(4)
    rows = [
        {
            "draw_date": f"{2000 + index // 12:04d}-{1 + index % 12:02d}-01",
            "first_prize": "".join(rng.choice("0123456789") for _ in range(6)),
            "bottom_two": f"{rng.randrange(100):02d}",
        }
        for index in range(120)
    ]

    payload = report(rows, draws=5)
    overall = payload["accuracy"]["positional"]["overall"]

    assert overall["predictions"] == sum(
        comparison["position_predictions"] for comparison in payload["comparisons"]
    )
    assert overall["hits"] == sum(
        comparison["position_hits"] for comparison in payload["comparisons"]
    )

    for name, block in payload["accuracy"]["positional"]["positions"].items():
        expected = sum(
            1
            for comparison in payload["comparisons"]
            for entry in comparison["positions"]
            if entry["name"] == name and entry["hit"]
        )
        assert block["hits"] == expected, name


def test_the_report_states_that_it_is_a_replay_and_not_a_record():
    """**The claim this feature could most easily get wrong.** Nothing stores a
    prediction, so every number here is a reconstruction; the payload must say so in
    a machine-readable field and in prose, and must name what a real record would
    need."""
    payload = report(ledger(60), draws=1)

    assert payload["prediction_basis"] == "walk_forward_replay"
    assert "replayed" in payload["replay_notice"]
    assert "not recorded" in payload["replay_notice"]

    limitations = " ".join(payload["limitations"])
    assert "Replay, not a record" in limitations
    assert "3-digit" in limitations
    assert "10%" in limitations


def test_an_empty_ledger_is_an_empty_state_and_not_an_error():
    payload = report([])

    assert payload["status"] == "insufficient_data"
    assert payload["comparisons"] == []
    assert payload["draws_evaluated"] == 0
    assert payload["limitations"]  # still states the rules it cannot apply
    assert payload["warnings"]


def test_a_ledger_with_no_replayable_draw_compares_nothing():
    """Every recent draw is a candidate target, and a target needs at least
    `MIN_TRAIN_DRAWS` earlier draws. Below that, nothing may be published — a
    comparison made without history would be a fabricated one."""
    payload = report(ledger(backtest.MIN_TRAIN_DRAWS))

    assert payload["comparisons"] == []
    assert payload["status"] == "insufficient_data"
    assert any("fabricated comparison" in warning for warning in payload["warnings"])


def test_asking_for_more_draws_than_the_ledger_holds_is_reported_not_failed():
    payload = report(ledger(30), draws=accuracy.MAX_DRAWS)

    assert payload["draws_requested"] == accuracy.MAX_DRAWS
    assert payload["draws_evaluated"] == len(payload["comparisons"]) == 10
    assert payload["status"] == "limited"
    assert any("had fewer than" in warning for warning in payload["warnings"])


def test_the_comparisons_are_newest_first_and_the_range_matches():
    payload = report(ledger(40), draws=4)

    dates = [comparison["draw_date"] for comparison in payload["comparisons"]]
    assert dates == sorted(dates, reverse=True)
    assert payload["date_range"]["to"] == dates[0]
    assert payload["date_range"]["from"] == dates[-1]


def test_the_same_rows_always_produce_the_same_report():
    """Reproducible from the ledger alone: no clock, no RNG, no database. A report
    that moved between runs could not be checked by anyone."""
    rows = ledger(40)

    assert report(rows, draws=3) == report(rows, draws=3)


def test_the_train_size_is_reported_for_every_comparison():
    """The sample each comparison rests on, on screen next to it — the same rule the
    backtest follows for its window."""
    payload = report(ledger(40), draws=2)

    for comparison in payload["comparisons"]:
        assert comparison["train_size"] >= backtest.MIN_TRAIN_DRAWS
    assert payload["train_sizes"]["min"] <= payload["train_sizes"]["max"]
    assert payload["train_window"] == 400


# ---------------------------------------------------------------------------
# The leakage property — the one that makes the numbers mean anything
# ---------------------------------------------------------------------------
def test_the_model_is_handed_only_the_draws_before_its_target(monkeypatch):
    """Spy on the model, not on the slicing code.

    `accuracy.compare_draw` must hand the positional model exactly
    `frame[t - train_window : t]`, so this asserts on the rows the model actually
    receives: every one of them older than the target, and the target itself absent.
    `services.analyse_draws` is checked in the same pass, because the 2-digit
    channels are scored in the same report and leak the same way if they are wrong.
    """
    seen: list[tuple[str, list[str]]] = []

    real_positions = models.bayesian.analyse_positions
    real_channels = services.analyse_draws

    def spy_positions(rows, **kwargs):
        seen.append(("positions", [row["draw_date"] for row in rows]))
        return real_positions(rows, **kwargs)

    def spy_channels(rows, **kwargs):
        seen.append(("channels", [row["draw_date"] for row in rows]))
        return real_channels(rows, **kwargs)

    monkeypatch.setattr(models.bayesian, "analyse_positions", spy_positions)
    monkeypatch.setattr(services, "analyse_draws", spy_channels)

    rows = ledger(40)
    frame, _ = services.prepare_history(rows)
    index = 30
    target_date = frame.iloc[index].draw_date.date().isoformat()

    accuracy.compare_draw(frame, index, train_window=400, digits=6, top_k=5)

    assert {kind for kind, _ in seen} == {"positions", "channels"}
    expected = [
        row["draw_date"] for row in backtest.training_slice(frame, index, 400)
    ]
    for kind, dates in seen:
        assert dates == expected, kind
        assert target_date not in dates, kind
        assert all(date < target_date for date in dates), kind
        assert len(dates) == index, kind


def test_a_full_report_never_shows_the_model_the_newest_draw_it_scores(monkeypatch):
    """The same property through `build_report`, which is what the endpoint calls.

    Every target here is one of the most recent draws, and every target's training
    slice stops before it — so the newest draw is never in any slice, and the model
    is never shown a row it is about to be graded on.
    """
    captured: list[list[str]] = []

    real = services.analyse_draws

    def spy(rows, **kwargs):
        captured.append([row["draw_date"] for row in rows])
        return real(rows, **kwargs)

    monkeypatch.setattr(services, "analyse_draws", spy)

    rows = ledger(40)
    newest = services.prepare_history(rows)[0].iloc[-1].draw_date.date().isoformat()

    report(rows, draws=3)

    assert len(captured) == 3
    for dates in captured:
        assert newest not in dates
        assert all(date < newest for date in dates)


# ---------------------------------------------------------------------------
# HTTP — the gate on /api/premium/accuracy-report
# ---------------------------------------------------------------------------
class _FakeAuth:
    """`client.auth`, returning the shape supabase-py actually produces.

    A `TypedDict` is a plain `dict` at runtime, so a fake that exposes `.claims` as
    an attribute would agree with a read the library never satisfies — the mistake
    that once refused every valid token. See `test_auth.py`.
    """

    def __init__(self, claims: dict) -> None:
        self._claims = claims

    def get_claims(self, _token: str):
        return {"claims": self._claims, "headers": {"alg": "ES256"}, "signature": b""}


class _FakeClient:
    def __init__(self, claims: dict) -> None:
        self.auth = _FakeAuth(claims)


def claims_for(sub: str = USER_ID) -> dict:
    return {
        "sub": sub,
        "email": "subscriber@example.test",
        "role": "authenticated",
        "aud": "authenticated",
    }


@pytest.fixture()
def signed_in(monkeypatch: pytest.MonkeyPatch):
    """A real gate and a controllable subscription tier.

    Only the two Supabase seams are stubbed — token validation's client and the
    profile read — so `require_user` and `require_premium_user` both run for real.
    That is what makes a 403 here a statement about the gate rather than about a
    fixture that bypassed it.

    Returns a setter, so one test can move an account from free to lapsed to
    subscribed without rebuilding the app.
    """

    class Harness:
        def __init__(self) -> None:
            self.tier = "free"
            self.expiry: str | None = None

        def as_payload(self) -> dict:
            return {
                "id": USER_ID,
                "email": "subscriber@example.test",
                "subscription_tier": self.tier,
                "subscription_expiry": self.expiry,
                "subscription_provider": None,
                "stripe_customer_id": None,
            }

    harness = Harness()
    monkeypatch.setattr(main, "get_supabase", lambda: _FakeClient(claims_for()))
    monkeypatch.setattr(
        auth, "read_profile", lambda *_args, **_kwargs: harness.as_payload()
    )
    # The draw ledger, so a 200 can be reached without a database. The gate has
    # already run by the time this is called.
    monkeypatch.setattr(
        main,
        "fetch_draw_history",
        lambda _client, _limit, _type=main.LotteryType.thai: ledger(40),
    )
    return harness


def test_without_a_token_the_report_is_a_401(signed_in):
    response = TestClient(main.app).get("/api/premium/accuracy-report")

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_a_free_account_is_refused_with_403(signed_in):
    """The requirement, stated as a test: a valid session with no subscription does
    not get this report, exactly as it does not get `/api/predict/premium`."""
    signed_in.tier = "free"

    response = TestClient(main.app).get(
        "/api/premium/accuracy-report", headers={"Authorization": "Bearer good-token"}
    )

    assert response.status_code == 403
    assert "no active premium subscription" in response.json()["detail"]


def test_a_lapsed_subscription_is_refused_with_402(signed_in):
    signed_in.tier = "premium"
    signed_in.expiry = "2020-01-01T00:00:00+00:00"

    response = TestClient(main.app).get(
        "/api/premium/accuracy-report", headers={"Authorization": "Bearer good-token"}
    )

    assert response.status_code == 402
    assert "expired" in response.json()["detail"]


def test_a_premium_account_gets_the_report(signed_in):
    signed_in.tier = "premium"

    response = TestClient(main.app).get(
        "/api/premium/accuracy-report",
        params={"type": "thai", "draws": 3},
        headers={"Authorization": "Bearer good-token"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["lottery_type"] == "thai"
    assert payload["prediction_basis"] == "walk_forward_replay"
    assert len(payload["comparisons"]) == 3
    assert payload["comparisons"][0]["positions"]
    assert payload["accuracy"]["positional"]["overall"]["baseline_percent"] == 10.0


def test_the_endpoint_is_advertised_as_gated(signed_in):
    """`/api/health` lists the endpoints behind the paywall. The list is compared for
    equality rather than membership so adding a paid endpoint without declaring it
    fails here — which is the only way that list stays true."""
    payload = TestClient(main.app).get("/api/health").json()

    assert payload["auth"]["gated_endpoints"] == [
        "/api/predict/premium",
        "/api/premium/accuracy-report",
    ]


@pytest.mark.parametrize("draws", [0, 21, 1000])
def test_the_draw_count_is_bounded(signed_in, draws):
    """A request budget, not a statistical one: 20 draws is about 1.5 s of compute."""
    signed_in.tier = "premium"

    response = TestClient(main.app).get(
        "/api/premium/accuracy-report",
        params={"draws": draws},
        headers={"Authorization": "Bearer good-token"},
    )

    assert response.status_code == 422


def test_an_unknown_ledger_is_refused(signed_in):
    signed_in.tier = "premium"

    response = TestClient(main.app).get(
        "/api/premium/accuracy-report",
        params={"type": "malaysia"},
        headers={"Authorization": "Bearer good-token"},
    )

    assert response.status_code == 422


def test_the_token_never_appears_in_the_response(signed_in):
    signed_in.tier = "premium"

    response = TestClient(main.app).get(
        "/api/premium/accuracy-report",
        headers={"Authorization": "Bearer super-secret-token"},
    )

    assert "super-secret-token" not in response.text


def test_the_documented_premium_fixture_still_reaches_the_endpoint(monkeypatch, premium_account):
    """The suite-wide override in `conftest.py` covers this endpoint too, so the
    model suites keep testing the maths without re-testing the door."""
    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(
        main,
        "fetch_draw_history",
        lambda _client, _limit, _type=main.LotteryType.thai: ledger(40),
    )
    grant_premium()

    response = TestClient(main.app).get("/api/premium/accuracy-report", params={"draws": 2})

    assert response.status_code == 200, response.text
    assert len(response.json()["comparisons"]) == 2
