"""Unit tests for the Day 3 models (`services.py`).

Every expected value here is computed by hand from a synthetic history, not
copied out of a program run — otherwise the test would only assert that the code
still does whatever it already did.

Run from the `backend` directory:

    .venv/Scripts/python -m pytest -q
"""

from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
import pytest

import services as svc

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def rows_for(top_codes: list[str], bottom_codes: list[str] | None = None) -> list[dict]:
    """Build ledger rows whose `first_prize` ends in the given 2-digit codes."""
    if bottom_codes is None:
        bottom_codes = ["11"] * len(top_codes)
    base = date(2010, 1, 1)
    return [
        {
            "draw_date": (base + timedelta(days=15 * index)).isoformat(),
            "first_prize": f"1234{top}",  # exactly 6 digits; last 2 = top
            "bottom_two": bottom,
        }
        for index, (top, bottom) in enumerate(zip(top_codes, bottom_codes))
    ]


@pytest.fixture()
def alternating() -> pd.Series:
    """Ten strict alternations: 07, 48, 07, 48, ... (20 draws, last = 48)."""
    return pd.Series(["07", "48"] * 10, dtype="object")


# ---------------------------------------------------------------------------
# Frequency analysis
# ---------------------------------------------------------------------------


def test_frequency_counts_covers_the_whole_universe():
    series = pd.Series(["48", "48", "17"], dtype="object")
    counts = svc.frequency_counts(series)

    assert len(counts) == 100, "every code must be present, including unseen ones"
    assert counts["48"] == 2
    assert counts["17"] == 1
    assert counts["00"] == 0


def test_frequency_counts_sum_to_the_sample_size():
    series = pd.Series(["48", "48", "17", "99"], dtype="object")
    assert int(svc.frequency_counts(series).sum()) == len(series)


def test_top_frequency_ranks_by_count_then_code():
    # 48 appears 3x, 17 appears 2x, everything else once.
    series = pd.Series(["48"] * 3 + ["17"] * 2 + ["99"], dtype="object")
    top = svc.top_frequency(series, top_n=3)

    assert [row.code for row in top] == ["48", "17", "99"]
    assert [row.count for row in top] == [3, 2, 1]


def test_frequency_expected_and_lift_are_the_uniform_baseline():
    series = pd.Series(["48"] * 5, dtype="object")
    row = svc.top_frequency(series, top_n=1)[0]

    # expected = draws / 100 = 5 / 100
    assert row.expected == pytest.approx(0.05)
    # lift = count / expected = 5 / 0.05 = 100x the uniform rate
    assert row.lift == pytest.approx(100.0)
    assert row.share == pytest.approx(1.0)


def test_frequency_ties_are_broken_deterministically():
    series = pd.Series(["48", "17"], dtype="object")
    first = [(r.code, r.count) for r in svc.top_frequency(series, top_n=2)]
    second = [(r.code, r.count) for r in svc.top_frequency(series, top_n=2)]

    assert first == second
    assert first == [("17", 1), ("48", 1)], "equal counts must fall back to code order"


def test_draws_since_last_seen():
    series = pd.Series(["48", "17", "99", "48"], dtype="object")
    assert svc.draws_since_last_seen(series, "48") == 0
    assert svc.draws_since_last_seen(series, "99") == 1
    assert svc.draws_since_last_seen(series, "17") == 2
    assert svc.draws_since_last_seen(series, "00") is None


# ---------------------------------------------------------------------------
# Data preparation
# ---------------------------------------------------------------------------


def test_prepare_history_sorts_oldest_first():
    rows = [
        {"draw_date": "2020-06-01", "first_prize": "111111", "bottom_two": "22"},
        {"draw_date": "2019-01-01", "first_prize": "222222", "bottom_two": "33"},
        {"draw_date": "2021-03-01", "first_prize": "333333", "bottom_two": "44"},
    ]
    frame, warnings = svc.prepare_history(rows)

    assert list(frame["draw_date"].dt.year) == [2019, 2020, 2021]
    assert frame.index.tolist() == [0, 1, 2], "index must be a clean 0..n-1 range"
    assert warnings == []


def test_prepare_history_derives_top2_from_the_first_prize_only():
    rows = rows_for(["07"], ["79"])
    frame, _ = svc.prepare_history(rows)

    assert frame.at[0, "top"] == "07"
    # The official bottom_two is NOT the trailing digits of first_prize (123407).
    assert frame.at[0, "bottom"] == "79"


def test_prepare_history_rejects_malformed_prizes_instead_of_truncating():
    """A bad prize invalidates its channel only, not the whole draw.

    GLO can legitimately have one prize present and the other missing, so
    discarding an entire row because one channel is unparseable would throw away
    usable history from the other position.
    """
    rows = [
        {"draw_date": "2020-01-01", "first_prize": "12345", "bottom_two": "22"},  # 5 digits
        {"draw_date": "2020-01-16", "first_prize": "1234567", "bottom_two": "33"},  # 7 digits
        {"draw_date": "2020-02-01", "first_prize": "ABCDEF", "bottom_two": "44"},  # not digits
        {"draw_date": "2020-02-16", "first_prize": "123456", "bottom_two": "5"},  # 1 digit
        {"draw_date": "2020-03-01", "first_prize": "654321", "bottom_two": "55"},  # valid
    ]
    frame, warnings = svc.prepare_history(rows)

    # Every row remains usable in at least one channel, so all five are kept.
    assert len(frame) == 5
    # Three unparseable first prizes must be blanked, not truncated to "45"/"67"/"EF".
    assert int(frame["top"].isna().sum()) == 3
    assert int(frame["bottom"].isna().sum()) == 1  # the 1-digit bottom_two
    assert frame.at[4, "top"] == "21"  # 654321 -> last two digits
    assert frame.at[4, "bottom"] == "55"
    assert frame.at[0, "bottom"] == "22", "the valid channel survives its bad partner"
    assert any("top: dropped 3 row(s)" in w for w in warnings)
    assert any("bottom: dropped 1 row(s)" in w for w in warnings)


def test_prepare_history_keeps_a_row_valid_in_only_one_channel():
    rows = [{"draw_date": "2020-01-01", "first_prize": "123407", "bottom_two": "bad"}]
    frame, _ = svc.prepare_history(rows)

    assert len(frame) == 1
    assert frame.at[0, "top"] == "07"
    assert pd.isna(frame.at[0, "bottom"])


def test_prepare_history_is_empty_and_graceful_for_no_rows():
    frame, warnings = svc.prepare_history([])

    assert frame.empty
    assert warnings, "an empty input must explain itself"


# ---------------------------------------------------------------------------
# Transition matrix
# ---------------------------------------------------------------------------


def test_transition_counts_match_hand_counted_pairs(alternating):
    counts = svc.transition_counts(alternating)

    assert counts.at["07", "48"] == 10
    assert counts.at["48", "07"] == 9
    assert int(counts.values.sum()) == len(alternating) - 1, "n draws give n-1 pairs"


def test_every_transition_matrix_row_sums_to_one(alternating):
    """ROADMAP Day 3 DoD: transition matrix rows are normalised."""
    matrix = svc.transition_matrix(svc.transition_counts(alternating))

    assert matrix.shape == (100, 100)
    for code in svc.NUMBER_UNIVERSE:
        assert matrix.loc[code].sum() == pytest.approx(1.0, abs=1e-9), f"row {code}"


def test_unvisited_rows_are_uniform_not_undefined(alternating):
    matrix = svc.transition_matrix(svc.transition_counts(alternating))

    # "00" never appeared, so its row has no observations at all.
    assert matrix.loc["00"].sum() == pytest.approx(1.0)
    assert matrix.at["00", "48"] == pytest.approx(1.0 / 100)


def test_smoothing_keeps_unseen_transitions_non_zero():
    series = pd.Series(["07", "48"], dtype="object")
    matrix = svc.transition_matrix(svc.transition_counts(series))

    # 07 -> 99 was never observed, but must not be assigned probability zero.
    assert matrix.at["07", "99"] > 0.0


def test_zero_smoothing_does_not_produce_nan():
    series = pd.Series(["07", "48"], dtype="object")
    matrix = svc.transition_matrix(svc.transition_counts(series), smoothing=0.0)

    assert not matrix.isna().to_numpy().any()
    assert matrix.loc["00"].sum() == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Markov chain
# ---------------------------------------------------------------------------


def test_markov_support_and_conditional_probability_are_exact(alternating):
    result = svc.markov_analysis(alternating, "top")

    assert result.current_state == "48", "the state defaults to the most recent draw"
    assert result.support == 9, "48 was followed by something 9 times"

    k = svc.DEFAULT_SMOOTHING
    expected = (9 + k) / (9 + k * 100)  # observed successor 07
    other = (0 + k) / (9 + k * 100)  # every unobserved successor

    by_code = {row.code: row for row in result.rows}
    assert by_code["07"].conditional == pytest.approx(expected)
    assert by_code["00"].conditional == pytest.approx(other)
    assert by_code["07"].count == 9
    assert by_code["00"].count == 0


def test_markov_distribution_sums_to_one(alternating):
    assert svc.markov_analysis(alternating, "top").distribution().sum() == pytest.approx(1.0)


def test_markov_ranks_the_observed_successor_first(alternating):
    result = svc.markov_analysis(alternating, "top")
    assert result.rows[0].code == "07"


def test_perfect_alternation_has_lift_of_about_one(alternating):
    """07 follows 48 every time, but 07 is also the joint-most-common code.

    Its conditional rate therefore equals its unconditional rate: a conditional
    pattern that carries no information beyond the base rate must show lift ~1,
    not a large number.
    """
    result = svc.markov_analysis(alternating, "top")
    by_code = {row.code: row for row in result.rows}

    assert by_code["07"].lift == pytest.approx(1.0, abs=0.01)


def test_lift_reports_a_genuinely_rare_successor():
    """48 -> 99 happens 10 times; 99 appears nowhere else, out of 1000 draws.

    conditional(99|48) = 11/110 = 0.1
    unconditional(99)  = 11/1100 = 0.01   ->  lift 10.0
    """
    sequence: list[str] = []
    for _ in range(10):
        sequence += ["48", "99"]
    sequence += ["11"] * 980
    series = pd.Series(sequence, dtype="object")

    result = svc.markov_analysis(series, "top", current_state="48")
    by_code = {row.code: row for row in result.rows}

    assert result.support == 10
    assert by_code["99"].count == 10
    assert by_code["99"].conditional == pytest.approx(11 / 110)
    assert by_code["99"].unconditional == pytest.approx(11 / 1100)
    assert by_code["99"].lift == pytest.approx(10.0)


def test_markov_is_not_usable_below_the_support_floor():
    # The state is the LAST draw (48); an earlier 48 was followed by 99, so the
    # state has exactly one known successor - below the floor of three.
    series = pd.Series(["48", "99", "48"], dtype="object")
    result = svc.markov_analysis(series, "top")

    assert result.current_state == "48"
    assert result.support == 1
    assert result.usable is False
    assert result.support < svc.MIN_MARKOV_SUPPORT


def test_state_occurring_only_at_the_end_has_no_support():
    series = pd.Series(["07", "99", "48"], dtype="object")
    result = svc.markov_analysis(series, "top")

    assert result.current_state == "48"
    assert result.support == 0
    assert result.usable is False


def test_markov_on_an_empty_series_does_not_raise():
    result = svc.markov_analysis(pd.Series([], dtype="object"), "top")

    assert result.support == 0
    assert result.rows == []
    assert result.usable is False


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("score", "tone"),
    [
        (100.0, "high"),
        (75.0, "high"),
        (74.99, "medium"),
        (55.0, "medium"),
        (54.99, "low"),
        (35.0, "low"),
        (34.99, "cold"),
        (0.0, "cold"),
    ],
)
def test_tone_boundaries_match_the_frontend(score, tone):
    """These boundaries must agree with probabilityTone() in theme.ts."""
    assert svc.signal_tone(score) == tone


def test_rank_normalise_spans_zero_to_one():
    values = pd.Series([5.0, 3.0, 1.0], index=["a", "b", "c"])
    normalised = svc.rank_normalise(values)

    assert normalised["a"] == pytest.approx(1.0)
    assert normalised["c"] == pytest.approx(0.0)
    assert normalised["b"] == pytest.approx(0.5)


def test_rank_normalise_gives_ties_the_same_value():
    values = pd.Series([1.0, 1.0, 1.0], index=["a", "b", "c"])
    normalised = svc.rank_normalise(values)

    assert normalised.nunique() == 1


def test_scores_stay_within_zero_and_one_hundred(alternating):
    result = svc.score_channel(alternating, "top")
    scores = [pick["score"] for pick in result.rankings]

    assert scores, "picks must be produced"
    assert all(0.0 <= score <= 100.0 for score in scores)


def test_a_missing_markov_signal_is_redistributed_not_zeroed():
    """Below the support floor the score must become frequency-only."""
    series = pd.Series(["07", "99", "48"], dtype="object")  # support 1 for 48
    warnings: list[str] = []
    result = svc.score_channel(series, "top", warnings=warnings)

    assert result.weights == {"frequency": 1.0}
    assert any("no usable markov signal" in w for w in warnings)


def test_probabilities_are_rates_not_a_chance_of_winning():
    """A 2-digit code cannot honestly be given a large per-draw probability.

    Uses a realistically spread history: 400 draws cycling every code, with a
    handful of extra 48s. A degenerate two-code fixture would report a 50%
    frequency rate and correctly fail this guard — that would be a statement
    about the fixture, not the model.
    """
    codes = [f"{index % 100:02d}" for index in range(400)] + ["48"] * 10
    result = svc.score_channel(pd.Series(codes, dtype="object"), "top")

    assert result.rankings
    for pick in result.rankings:
        assert pick["probability"] < 15.0, pick


def test_each_signal_is_a_normalised_probability_distribution():
    """Both signals must sum to 1 across the universe.

    This is what makes the blended `probability` an occurrence rate rather than
    a number that happens to look plausible.
    """
    codes = [f"{index % 100:02d}" for index in range(400)]
    series = pd.Series(codes, dtype="object")

    assert svc.frequency_counts(series).sum() / len(series) == pytest.approx(1.0)
    assert svc.markov_analysis(series, "top").distribution().sum() == pytest.approx(1.0)


def test_rankings_carry_the_frontend_rank_entry_contract(alternating):
    """ROADMAP Day 3 DoD: shape matches RankEntry in src/data/mock.ts."""
    required = {"code", "probability", "score", "delta", "lastSeenDays"}
    result = svc.score_channel(alternating, "top")

    for pick in result.rankings:
        assert required <= set(pick), required - set(pick)
        assert isinstance(pick["code"], str) and len(pick["code"]) == 2
        assert isinstance(pick["probability"], float)
        assert isinstance(pick["score"], float)
        assert isinstance(pick["delta"], float)


def test_rankings_are_limited_to_top_five_by_default(alternating):
    result = svc.score_channel(alternating, "top")
    assert len(result.rankings) == 5


def test_top_five_frequencies_are_returned_alongside_the_picks(alternating):
    result = svc.score_channel(alternating, "top")

    assert len(result.frequencies) == 5
    # 07 and 48 are tied on 10 draws each and lead on the (count desc, code asc) key;
    # the remaining three slots go to unseen codes, which is reported as such.
    assert [row.code for row in result.frequencies][:2] == ["07", "48"]
    assert [row.count for row in result.frequencies][:2] == [10, 10]
    assert result.frequencies[2].count == 0


# ---------------------------------------------------------------------------
# Top-level orchestration
# ---------------------------------------------------------------------------


def test_analyse_draws_is_deterministic():
    """The same ledger must produce byte-identical output."""
    rows = rows_for(["07", "48"] * 8, ["11"] * 16)
    first = svc.analyse_draws(rows)
    second = svc.analyse_draws(rows)

    assert first == second


def test_analyse_draws_reports_both_channels():
    rows = rows_for(["07", "48"] * 8, ["11", "22"] * 8)
    result = svc.analyse_draws(rows)

    assert set(result["channels"]) == {"top", "bottom"}
    for channel in ("top", "bottom"):
        assert len(result["channels"][channel]["rankings"]) == 5


def test_analyse_draws_returns_insufficient_data_rather_than_raising():
    result = svc.analyse_draws([])

    assert result["status"] == "insufficient_data"
    assert result["draws_analyzed"] == 0
    assert result["channels"]["top"]["rankings"] == []
    assert result["warnings"], "the caller must be told why nothing was produced"


def test_analyse_draws_flags_a_tiny_history():
    rows = rows_for(["07", "48", "07"], ["11", "22", "33"])
    result = svc.analyse_draws(rows)

    assert result["status"] in {"limited", "insufficient_data"}
    assert any("indicative only" in w for w in result["warnings"])


def test_thin_markov_support_is_flagged_and_shows_as_limited():
    """This is the EXPECTED steady state, not an edge case.

    With ~400 draws over 100 possible states, the most recent code has usually
    appeared about 4 times, so its conditional estimate rests on ~3 transitions.
    The response must say so rather than present the ranking as confident.
    """
    # Filler deliberately excludes "48", otherwise the natural cycle would add
    # extra occurrences of the code under test and inflate its support.
    filler = [f"{index:02d}" for index in range(100) if index != 48]
    sequence = [filler[index % len(filler)] for index in range(400)]
    for position in (0, 50, 100, 399):
        sequence[position] = "48"  # the last one becomes the current state
    assert sequence.count("48") == 4

    result = svc.analyse_draws(rows_for(sequence))

    top = result["channels"]["top"]
    assert top["current_state"] == "48"
    assert top["markov"]["support"] == 3, "three earlier 48s have a known successor"
    assert top["markov"]["usable"] is True, "3 meets the usability floor"
    assert top["markov"]["support"] < svc.MIN_MARKOV_STRONG
    assert result["status"] == "limited"
    assert any("weak evidence" in w for w in result["warnings"]), result["warnings"]


def test_strong_markov_support_is_reported_as_ok():
    """A long, genuinely repeating pattern must NOT be downgraded to limited."""
    sequence = ["48", "99"] * 60  # 120 draws; 48 recurs 60 times
    result = svc.analyse_draws(rows_for(sequence))

    top = result["channels"]["top"]
    assert top["markov"]["support"] >= svc.MIN_MARKOV_STRONG, top["markov"]["support"]
    assert result["status"] == "ok", result["warnings"]


def test_analyse_draws_states_the_honest_interpretation():
    rows = rows_for(["07", "48"] * 8)
    result = svc.analyse_draws(rows)

    assert "not a probability of winning" in result["methodology"]


def test_weight_profiles_are_normalised():
    rows = rows_for(["07", "48"] * 20)
    result = svc.analyse_draws(rows, weights={"frequency": 0.3, "markov": 0.7})

    weights = result["channels"]["top"]["weights"]
    assert sum(weights.values()) == pytest.approx(1.0)
    assert result["weights_configured"] == {"frequency": 0.3, "markov": 0.7}


# ---------------------------------------------------------------------------
# Model statuses — every model is reported, active or neutral
# ---------------------------------------------------------------------------


def statuses_of(pick: dict) -> dict:
    return pick["model_statuses"]


def test_the_status_map_is_completed_for_every_model():
    """A model the caller said nothing about is still listed, as neutral."""
    statuses = svc.build_model_statuses({})

    assert list(statuses) == list(svc.MODEL_KEYS), "display order, and nothing missing"
    for key, entry in statuses.items():
        assert entry["label"] == svc.MODEL_LABELS[key]
        assert entry["status"] == svc.STATUS_NEUTRAL
        assert entry["reason"] == svc.REASON_NOT_REPORTED
        assert entry["weight"] == 0.0
        assert entry["detail"], "an omission is never unlabelled"


def test_refining_for_one_pick_keeps_all_four_models_and_their_labels():
    channel = svc.build_model_statuses(
        {
            "frequency": svc.model_entry(
                svc.STATUS_ACTIVE, weight=0.5, reason=svc.REASON_APPLIED, detail="kept"
            )
        }
    )
    refined = svc.refine_model_statuses(
        channel,
        {
            "markov": svc.model_entry(
                svc.STATUS_NEUTRAL,
                weight=0.0,
                reason=svc.REASON_NO_OBSERVED_TRANSITION,
                detail="replaced",
            )
        },
    )

    assert list(refined) == list(svc.MODEL_KEYS)
    assert refined["frequency"]["status"] == svc.STATUS_ACTIVE
    assert refined["frequency"]["detail"] == "kept"
    # The override carries no label of its own, so the channel's is preserved.
    assert refined["markov"]["label"] == svc.MODEL_LABELS["markov"]
    assert refined["markov"]["detail"] == "replaced"


def test_every_pick_reports_all_four_models_in_display_order():
    result = svc.analyse_draws(rows_for(["07", "48"] * 20))

    for pick in result["channels"]["top"]["rankings"]:
        assert list(statuses_of(pick)) == list(svc.MODEL_KEYS)
        for entry in statuses_of(pick).values():
            assert entry["status"] in {svc.STATUS_ACTIVE, svc.STATUS_NEUTRAL}
            assert entry["reason"]
            assert entry["detail"]
            assert entry["weight"] >= 0.0


def test_the_two_model_blend_names_the_models_it_does_not_use():
    """ARIMA and Monte Carlo are absent from Day 3's blend, not from its answer."""
    result = svc.analyse_draws(rows_for(["07", "48"] * 20))

    for pick in result["channels"]["top"]["rankings"]:
        statuses = statuses_of(pick)
        for key in ("timeseries", "montecarlo"):
            assert statuses[key]["status"] == svc.STATUS_NEUTRAL
            assert statuses[key]["reason"] == svc.REASON_NOT_IN_BLEND
            assert "two-model" in statuses[key]["detail"]
        # The two the blend really used are active, and carry their weight.
        assert statuses["frequency"]["status"] == svc.STATUS_ACTIVE
        assert statuses["frequency"]["weight"] == pytest.approx(0.5)


def test_an_unsupported_markov_signal_is_neutral_not_absent():
    """Support 1 is below the floor, so Markov is reported and marked neutral.

    Five draws are enough to rank (> ``MIN_DRAWS_ANY``) while the current state
    "48" still has a single known successor, which is the case the field has to
    describe: a model that ran and could not estimate anything.
    """
    series = pd.Series(["07", "99", "48", "55", "48"], dtype="object")
    result = svc.score_channel(series, "top")
    assert result.draws == 5

    markov = result.model_statuses["markov"]
    assert markov["status"] == svc.STATUS_NEUTRAL
    assert markov["reason"] == svc.REASON_INSUFFICIENT_SUPPORT
    assert "below the floor" in markov["detail"]
    # The model that did carry the blend is active with the whole weight.
    assert result.model_statuses["frequency"]["status"] == svc.STATUS_ACTIVE
    assert result.model_statuses["frequency"]["weight"] == pytest.approx(1.0)
    assert result.weights == {"frequency": 1.0}, "and the blend itself is unchanged"


def test_a_zero_weight_model_is_reported_as_neutral(alternating):
    result = svc.score_channel(alternating, "top", weights={"frequency": 1.0, "markov": 0.0})

    markov = result.model_statuses["markov"]
    assert markov["status"] == svc.STATUS_NEUTRAL
    assert markov["reason"] == svc.REASON_WEIGHTED_ZERO
    assert "zero weight" in markov["detail"]
    assert result.model_statuses["frequency"]["weight"] == pytest.approx(1.0)


def test_a_code_with_no_observed_transition_is_neutral_for_markov(alternating):
    """The distinction the field exists for: the model ran, and found nothing."""
    result = svc.score_channel(alternating, "top")

    observed = [pick for pick in result.rankings if pick["evidence"]["markov"]["count"] > 0]
    unobserved = [pick for pick in result.rankings if pick["evidence"]["markov"]["count"] == 0]
    assert observed and unobserved, "the fixture must produce both cases"

    for pick in observed:
        assert statuses_of(pick)["markov"]["status"] == svc.STATUS_ACTIVE
    for pick in unobserved:
        markov = statuses_of(pick)["markov"]
        assert markov["status"] == svc.STATUS_NEUTRAL
        assert markov["reason"] == svc.REASON_NO_OBSERVED_TRANSITION
        assert markov["weight"] == 0.0, "no measured evidence, so no weight"
        assert "smoothed prior" in markov["detail"]


def test_the_channel_and_its_picks_report_the_same_blend():
    result = svc.analyse_draws(rows_for(["07", "48"] * 20))
    channel = result["channels"]["top"]

    assert list(channel["model_statuses"]) == list(svc.MODEL_KEYS)
    for key in svc.MODEL_KEYS:
        # A pick can narrow the channel's status, never widen it.
        assert channel["model_statuses"][key]["status"] in {
            svc.STATUS_ACTIVE,
            svc.STATUS_NEUTRAL,
        }
    active = [k for k, v in channel["model_statuses"].items() if v["status"] == svc.STATUS_ACTIVE]
    assert active == ["frequency", "markov"]
    assert list(channel["weights"]) == active
