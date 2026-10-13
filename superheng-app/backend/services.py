"""SuperHeng — Day 3 statistical models.

Two model families over the historical draw ledger, plus the blending step that
turns them into a preliminary **Heng Score**:

``Frequency``
    Unconditional rate of each 2-digit code in a channel. Answers *"how often
    does 48 appear, relative to its uniform baseline?"*

``Markov``
    A first-order transition matrix estimated from consecutive draws. Answers
    the conditional question *"given that 01 was drawn last, what is the
    probability of each code next?"* — with add-k smoothing so an unseen
    transition is not assigned zero probability, and the observed **lift** over
    the unconditional rate reported alongside it.

Channels — and why there are two of them
----------------------------------------
The ledger has two genuinely different 2-digit quantities, and they must never
be pooled:

* ``top``    — the last two digits of ``first_prize``, **derived** for analysis.
* ``bottom`` — ``bottom_two``, GLO's **separately drawn** เลขท้าย 2 ตัว prize.

They are not the same draw. GLO draws its 2-digit prize independently, so a
model built on the wrong one for a position is simply modelling the wrong
variable — see ROADMAP.md's prize-semantics note. Every function here is
therefore per-channel, and nothing merges the two.

Honesty constraints (VISION.md §2.5, §5)
----------------------------------------
* The Heng Score measures **model agreement about historical behaviour**. It is
  not, and cannot be, a probability of winning.
* The draw is fair and independent. Any structure found here is a property of
  the sample and may be entirely noise, so observed support is reported with
  every output and a signal is dropped rather than guessed at when the evidence
  is too thin.
* Normalisation is **rank-based**, per VISION §2.5: the top-ranked candidate in
  a signal scores 1.0 and the bottom 0.0, regardless of the raw magnitudes. That
  makes the score an agreement measure rather than a hidden probability.

Only ``pandas`` (already a Day 2 dependency) is used — no new packages.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import pandas as pd

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CHANNELS: tuple[str, ...] = ("top", "bottom")

CHANNEL_LABELS: dict[str, str] = {
    "top": "2-digit Top (last 2 digits of รางวัลที่ 1)",
    "bottom": "2-digit Bottom (official เลขท้าย 2 ตัว)",
}

UNIVERSE_SIZE = 100
NUMBER_UNIVERSE: tuple[str, ...] = tuple(f"{i:02d}" for i in range(UNIVERSE_SIZE))

# Laplace / add-k smoothing constant for the transition matrix (VISION §2.2).
DEFAULT_SMOOTHING = 1.0

# Day 3 has only two model families, so the default blend is an even split.
# VISION §2.5's four-model profile (0.30 / 0.30 / 0.25 / 0.15) applies from Day 5
# once Time Series and Monte Carlo exist. Weights are configuration, never
# literals buried in the scoring code.
DEFAULT_WEIGHTS: dict[str, float] = {"frequency": 0.5, "markov": 0.5}

# Tone boundaries MUST match `probabilityTone()` in src/constants/theme.ts
# (>=75 high, >=55 medium, >=35 low, else cold), so the client and the API can
# never disagree about how a score should be coloured.
TONE_THRESHOLDS: tuple[tuple[float, str], ...] = (
    (75.0, "high"),
    (55.0, "medium"),
    (35.0, "low"),
    (0.0, "cold"),
)

# Sample-size floors. Below these a signal is reported as absent rather than
# presented with false precision — the whole point of the confidence label.
MIN_DRAWS_ANY = 5  # fewer than this and nothing is computable
MIN_DRAWS_FREQUENCY = 30  # below this, frequency ranks are indicative only
MIN_MARKOV_SUPPORT = 3  # below this, a conditional estimate is not evidence
# A conditional estimate drawn from fewer observations than this is fragile
# rather than wrong. With 100 possible states and a ~400-draw archive, the most
# recent code has typically appeared only 3-4 times, so this floor will usually
# be missed *on real data* and the response will honestly say so.
MIN_MARKOV_STRONG = 10

# A lift below this is not worth calling out as a driver in the reason string.
LIFT_STRONG = 1.5
LIFT_LOW = 1.2

TOP_N = 5

METHODOLOGY_NOTE = (
    "The Heng Score measures model agreement about historical behaviour, on a "
    "0-100 scale. It is not a probability of winning: a fair draw is "
    "independent, and any structure these models detect may be entirely noise."
)

# ---------------------------------------------------------------------------
# Data preparation
# ---------------------------------------------------------------------------


def derive_top2(first_prize: pd.Series) -> pd.Series:
    """Return the last 2 digits of each ``first_prize``, or NA when unusable.

    Kept strictly separate from ``bottom_two``: this is a DERIVED quantity for
    analysis, not an official prize. Values that are not exactly 6 digits are
    rejected rather than truncated, so a malformed row cannot silently become a
    plausible-looking code.
    """
    cleaned = first_prize.astype("string").str.strip()
    valid = cleaned.str.fullmatch(r"[0-9]{6}").fillna(False).astype(bool)
    out = pd.Series(pd.NA, index=first_prize.index, dtype="string")
    out[valid] = cleaned[valid].str.slice(-2)
    return out


def derive_bottom2(bottom_two: pd.Series) -> pd.Series:
    """Return the official 2-digit code, or NA when unusable."""
    cleaned = bottom_two.astype("string").str.strip()
    valid = cleaned.str.fullmatch(r"[0-9]{2}").fillna(False).astype(bool)
    out = pd.Series(pd.NA, index=bottom_two.index, dtype="string")
    out[valid] = cleaned[valid]
    return out


def prepare_history(rows: Iterable[Mapping[str, Any]]) -> tuple[pd.DataFrame, list[str]]:
    """Turn raw ``lottery_draws`` rows into a chronological analysis frame.

    Returns ``(frame, warnings)``. The frame is sorted **oldest first** and
    reindexed to a clean 0..n-1 RangeIndex so that "the next draw" is simply
    position ``i + 1`` — the ordering is what makes the Markov step meaningful,
    so it is established here, once, rather than trusted to the caller.

    Rows are never dropped silently: anything unusable is counted and reported.
    """
    warnings: list[str] = []

    if not rows:
        return pd.DataFrame(columns=["draw_date", "top", "bottom", "first_prize", "bottom_two"]), [
            "No draw rows were supplied."
        ]

    frame = pd.DataFrame(list(rows))
    for column in ("draw_date", "first_prize", "bottom_two"):
        if column not in frame.columns:
            raise ValueError(f"draw rows are missing the required column {column!r}")

    frame["draw_date"] = pd.to_datetime(frame["draw_date"], errors="coerce")
    malformed_dates = int(frame["draw_date"].isna().sum())
    if malformed_dates:
        warnings.append(f"Dropped {malformed_dates} row(s) with an unparseable draw_date.")
        frame = frame[frame["draw_date"].notna()]

    # Newest-first input (as the query returns it) becomes oldest-first.
    frame = frame.sort_values("draw_date", kind="stable").reset_index(drop=True)

    frame["top"] = derive_top2(frame["first_prize"])
    frame["bottom"] = derive_bottom2(frame["bottom_two"])

    for channel in CHANNELS:
        invalid = int(frame[channel].isna().sum())
        if invalid:
            warnings.append(
                f"{channel}: dropped {invalid} row(s) whose value was not a valid 2-digit code."
            )

    # A draw may be valid in one channel and not the other, so require at least
    # one usable channel rather than dropping the row outright.
    frame = frame[frame[list(CHANNELS)].notna().any(axis=1)].reset_index(drop=True)

    if frame.empty:
        warnings.append("No usable draws remained after validation.")

    return frame, warnings


def channel_series(frame: pd.DataFrame, channel: str) -> pd.Series:
    """The chronological, gap-free series for one channel."""
    if channel not in CHANNELS:
        raise ValueError(f"unknown channel {channel!r}; expected one of {CHANNELS}")
    series = frame[channel].dropna()
    return series.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Frequency analysis
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FrequencyRow:
    """One code's unconditional rate in a channel."""

    code: str
    count: int
    draws: int
    share: float  # count / draws
    expected: float  # draws / 100 — the uniform baseline
    lift: float  # count / expected; 1.0 means exactly uniform

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "count": self.count,
            "share": round(self.share, 6),
            "expected": round(self.expected, 3),
            "lift": round(self.lift, 3),
        }


def frequency_counts(series: pd.Series) -> pd.Series:
    """Absolute count per code across the whole universe, including zeros.

    Returning all 100 codes (not just the observed ones) keeps the candidate
    space fixed, which is what lets two signals be ranked against each other
    without a code silently disappearing from one of them.
    """
    counts = series.value_counts()
    return counts.reindex(NUMBER_UNIVERSE, fill_value=0).astype("int64")


def frequency_rows(series: pd.Series) -> list[FrequencyRow]:
    """Every code's frequency, ranked by count then code (deterministic).

    Always returns all 100 codes, **including for an empty series** (every count
    zero). The completeness is load-bearing: ``score_channel`` looks codes up by
    index, so a short list here would raise instead of degrading gracefully.
    """
    draws = int(len(series))
    counts = frequency_counts(series)
    expected = (draws / UNIVERSE_SIZE) if draws else 0.0

    rows = [
        FrequencyRow(
            code=code,
            count=int(count),
            draws=draws,
            share=(float(count) / draws) if draws else 0.0,
            expected=expected,
            lift=(float(count) / expected) if expected else 0.0,
        )
        for code, count in counts.items()
    ]
    # Explicit sort key: re-running on unchanged data must give identical output,
    # and pandas' tie order is not something to rely on.
    rows.sort(key=lambda row: (-row.count, row.code))
    return rows


def top_frequency(series: pd.Series, top_n: int = TOP_N) -> list[FrequencyRow]:
    """The ``top_n`` most frequently drawn codes. **Requirement: frequency analysis.**

    Returns an empty list for an empty series: "the 5 most frequent" is
    meaningless when nothing was drawn, and five zero-count rows would read as a
    result rather than an absence.
    """
    if len(series) == 0:
        return []
    return frequency_rows(series)[:top_n]


def draws_since_last_seen(series: pd.Series, code: str) -> int | None:
    """How many draws ago this code last appeared, or None if never in the window."""
    positions = series.index[series == code]
    if len(positions) == 0:
        return None
    return int(len(series) - 1 - int(positions[-1]))


# ---------------------------------------------------------------------------
# Markov chain
# ---------------------------------------------------------------------------


def transition_counts(series: pd.Series) -> pd.DataFrame:
    """Raw counts of ``state -> next state`` across consecutive draws.

    Every ordered pair ``(series[i], series[i + 1])`` is one observation, which
    is exactly the sample the conditional probability is estimated from. The
    final draw contributes no successor and is only ever a source.
    """
    matrix = pd.DataFrame(
        0, index=list(NUMBER_UNIVERSE), columns=list(NUMBER_UNIVERSE), dtype="int64"
    )
    values = series.tolist()
    for current, following in zip(values, values[1:]):
        matrix.at[current, following] += 1
    return matrix


def transition_matrix(counts: pd.DataFrame, smoothing: float = DEFAULT_SMOOTHING) -> pd.DataFrame:
    """Add-k smoothed transition **probabilities**; every row sums to 1.

    Smoothing is what keeps an unobserved transition usable: with k = 1 and 100
    outcomes, a row with no observations at all becomes uniform (0.01 each)
    rather than undefined, and a row with a single observation barely moves off
    uniform — which is the correct expression of "one observation is not
    evidence".

    A row therefore *always* sums to 1, including rows that were never visited.
    """
    if smoothing < 0:
        raise ValueError("smoothing must be non-negative")

    row_totals = counts.sum(axis=1)
    total = counts + smoothing
    denominator = row_totals + smoothing * counts.shape[1]

    # denominator is >= smoothing * 100 > 0 whenever smoothing > 0. With
    # smoothing == 0 an unvisited row would divide by zero, so it falls back to
    # the uniform distribution rather than producing NaN.
    probabilities = total.div(denominator.replace(0, pd.NA), axis=0)
    if smoothing == 0:
        empty = probabilities.isna().all(axis=1)
        probabilities.loc[empty] = 1.0 / counts.shape[1]
    return probabilities.astype("float64")


def unconditional_distribution(series: pd.Series, smoothing: float = DEFAULT_SMOOTHING) -> pd.Series:
    """Smoothed unconditional probability of each code, for the lift denominator."""
    counts = frequency_counts(series)
    draws = int(counts.sum())
    denominator = draws + smoothing * UNIVERSE_SIZE
    if denominator <= 0:
        return pd.Series(1.0 / UNIVERSE_SIZE, index=list(NUMBER_UNIVERSE))
    return ((counts + smoothing) / denominator).astype("float64")


@dataclass(frozen=True)
class MarkovRow:
    """One candidate's conditional probability after the current state."""

    code: str
    count: int  # raw transitions observed into this code
    conditional: float  # smoothed P(next = code | current)
    unconditional: float  # smoothed P(code) overall
    lift: float  # conditional / unconditional

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "count": self.count,
            "conditional": round(self.conditional, 6),
            "unconditional": round(self.unconditional, 6),
            "lift": round(self.lift, 3),
        }


@dataclass(frozen=True)
class MarkovResult:
    """The full conditional distribution after one state, plus its support."""

    channel: str
    current_state: str
    support: int  # observed transitions out of this state
    rows: list[MarkovRow] = field(default_factory=list)

    @property
    def usable(self) -> bool:
        return self.support >= MIN_MARKOV_SUPPORT

    def distribution(self) -> pd.Series:
        return pd.Series(
            {row.code: row.conditional for row in self.rows}, dtype="float64"
        ).reindex(NUMBER_UNIVERSE)

    def top(self, top_n: int = TOP_N) -> list[MarkovRow]:
        return self.rows[:top_n]

    def as_dict(self, top_n: int = TOP_N) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "current_state": self.current_state,
            "support": self.support,
            "usable": self.usable,
            "top_transitions": [row.as_dict() for row in self.top(top_n)],
        }


def markov_analysis(
    series: pd.Series,
    channel: str,
    *,
    smoothing: float = DEFAULT_SMOOTHING,
    current_state: str | None = None,
) -> MarkovResult:
    """Conditional distribution of the *next* draw, given the most recent one.

    **Requirement: basic Markov chain.** ``current_state`` defaults to the most
    recent value in the series. Every historical draw equal to that state whose
    successor is known contributes one observation; the successor distribution
    is then smoothed with add-k and reported with its observed support.

    Note on state design: the state is deliberately the same channel's 2-digit
    code, not "the whole previous draw". A whole-draw state (6-digit first prize
    plus 2-digit last prize) has 10^8 combinations and would essentially never
    repeat in a ~400-draw history, so it is unlearnable here rather than merely
    hard — see VISION §2.2's guidance to keep the state space well populated.
    """
    if len(series) == 0:
        return MarkovResult(channel=channel, current_state=current_state or "", support=0)

    state = current_state if current_state is not None else str(series.iloc[-1])

    counts = transition_counts(series)
    if state not in counts.index:
        return MarkovResult(channel=channel, current_state=state, support=0)
    probabilities = transition_matrix(counts, smoothing)
    unconditional = unconditional_distribution(series, smoothing)

    support = int(counts.loc[state].sum())
    rows: list[MarkovRow] = []
    for code in NUMBER_UNIVERSE:
        conditional = float(probabilities.at[state, code])
        base = float(unconditional.get(code, 0.0))
        rows.append(
            MarkovRow(
                code=code,
                count=int(counts.at[state, code]),
                conditional=conditional,
                unconditional=base,
                lift=(conditional / base) if base else 0.0,
            )
        )

    # Strongest first; ties broken by code so the output is reproducible.
    rows.sort(key=lambda row: (-row.conditional, row.code))
    return MarkovResult(channel=channel, current_state=state, support=support, rows=rows)


# ---------------------------------------------------------------------------
# Scoring — the preliminary Heng Score
# ---------------------------------------------------------------------------


def signal_tone(score: float) -> str:
    """Map a 0-100 score to a tone.

    Boundaries mirror ``probabilityTone()`` in src/constants/theme.ts exactly.
    """
    for threshold, tone in TONE_THRESHOLDS:
        if score >= threshold:
            return tone
    return TONE_THRESHOLDS[-1][1]


def rank_normalise(values: pd.Series) -> pd.Series:
    """Scale to 0-1 by rank, per VISION §2.5, with average ranks for ties.

    Rank-based on purpose: the score is meant to express *agreement between
    signals*, so what matters is where a candidate sits within each signal, not
    the raw magnitude — which for a fair draw is close to uniform anyway.

    One consequence worth understanding rather than "fixing": a signal that is
    mostly ties (a lightly-smoothed Markov row, where 95 of 100 codes are
    indistinguishable) gives its tied codes a *middle* value near 0.5, not 0.0 —
    average rank is the mean of the tied positions. So a near-uninformative
    signal pulls scores toward the middle and stops the score from spreading,
    which is the honest rendering of "we do not know much here". Callers surface
    the underlying support so a narrow spread is never mistaken for certainty.
    """
    if len(values) == 0:
        return values.astype("float64")
    if len(values) == 1:
        return pd.Series(1.0, index=values.index)

    ranks = values.rank(method="average", ascending=False)
    return (1.0 - (ranks - 1) / (len(values) - 1)).astype("float64")


def effective_weights(
    warnings: list[str],
    channel: str,
    available: Sequence[str],
    configured: Mapping[str, float],
    scope: str | None = None,
) -> dict[str, float]:
    """Renormalise the configured weights over the signals that actually exist.

    Dropping a missing signal and renormalising — rather than feeding it a
    constant — is what stops an absent Markov row (support below the floor, or a
    uniform smoothed row) from flattening every candidate onto the same score and
    making the ranking meaningless.

    ``scope`` names the blend this renormalisation feeds, and is only needed when
    a caller renormalises more than once for the same channel. The ensemble does
    exactly that — once for the per-draw rates that drive the simulation, once for
    the score — and without a label both passes emit the same sentence about the
    same missing signal, so a reader cannot tell which stage dropped it, or
    whether the line was merely printed twice. Day 3's single-pass caller leaves
    ``scope`` unset and keeps its established wording.
    """
    missing = [name for name in configured if name not in available]
    if missing:
        suffix = f" for the {scope}" if scope else ""
        warnings.append(
            f"{channel}: no usable {'/'.join(missing)} signal{suffix}, so its weight "
            "was redistributed across the remaining models."
        )

    kept = {name: float(configured[name]) for name in configured if name in available}
    total = sum(kept.values())
    if total <= 0:
        # Nothing available at all: fall back to an even split so the response is
        # still well-formed instead of dividing by zero.
        even = 1.0 / len(available) if available else 0.0
        return {name: even for name in available}
    return {name: weight / total for name, weight in kept.items()}


@dataclass
class ChannelResult:
    channel: str
    current_state: str
    draws: int
    weights: dict[str, float]
    frequencies: list[FrequencyRow]
    markov: MarkovResult
    rankings: list[dict[str, Any]]

    def as_dict(self) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "label": CHANNEL_LABELS[self.channel],
            "draws": self.draws,
            "current_state": self.current_state,
            "weights": {k: round(v, 4) for k, v in self.weights.items()},
            "frequencies": [row.as_dict() for row in self.frequencies],
            "markov": self.markov.as_dict(),
            "rankings": self.rankings,
        }


def build_reason(
    row: FrequencyRow,
    markov_row: MarkovRow | None,
    markov_usable: bool,
    current_state: str,
    channel: str,
) -> str:
    """A short, deterministic explanation assembled from the computed evidence.

    Deliberately not an LLM call: the explanation is generated from the numbers
    that actually drove the score, so it cannot invent a pattern or misreport a
    count. Every clause below is a fact read straight out of the analysis.
    """
    position = "top" if channel == "top" else "bottom"
    frequency_clause = (
        f"Drawn {row.count} times ({row.lift:.1f}x the uniform rate) as the "
        f"2-digit {position}."
    )

    if row.count == 0:
        frequency_clause = f"Never drawn as the 2-digit {position} in this window."

    if not markov_usable or markov_row is None:
        return f"{frequency_clause} No reliable Markov evidence after {current_state}."

    transitions = markov_row.count
    if transitions == 0:
        return (
            f"{frequency_clause} Not yet observed immediately after {current_state} "
            "in this window."
        )

    strength = "High"
    if markov_row.lift < LIFT_LOW:
        strength = "Weak"
    elif markov_row.lift < LIFT_STRONG:
        strength = "Moderate"

    return (
        f"{frequency_clause} {strength} transition probability from last draw: "
        f"{current_state} -> {markov_row.code} seen {transitions} of "
        f"{max(1, round(transitions / markov_row.conditional))} times "
        f"({markov_row.lift:.1f}x its usual rate)."
    )


def score_channel(
    series: pd.Series,
    channel: str,
    *,
    smoothing: float = DEFAULT_SMOOTHING,
    weights: Mapping[str, float] | None = None,
    top_n: int = TOP_N,
    warnings: list[str] | None = None,
    current_state: str | None = None,
) -> ChannelResult:
    """Frequency + Markov -> a ranked list of candidate codes with Heng Scores."""
    warnings = warnings if warnings is not None else []
    configured = dict(weights or DEFAULT_WEIGHTS)

    draws = int(len(series))
    markov = markov_analysis(series, channel, smoothing=smoothing, current_state=current_state)
    state = markov.current_state

    counts = frequency_counts(series)
    frequency_by_code = {row.code: row for row in frequency_rows(series)}

    signals: dict[str, pd.Series] = {"frequency": counts}
    if markov.usable:
        signals["markov"] = markov.distribution()

    usable = [name for name in configured if name in signals]
    applied = effective_weights(warnings, channel, usable, configured)

    normalised = {name: rank_normalise(signals[name]) for name in usable}

    # Raw probability estimates, blended only over available signals. Both are
    # genuine occurrence-rate estimates and both are far away from a per-draw
    # "chance of winning" figure.
    frequency_rate = (counts / draws) if draws else counts * 0.0
    rates: dict[str, pd.Series] = {"frequency": frequency_rate}
    if markov.usable:
        rates["markov"] = markov.distribution()

    markov_by_code = {row.code: row for row in markov.rows}

    rankings: list[dict[str, Any]] = []
    if draws >= MIN_DRAWS_ANY:
        for code in NUMBER_UNIVERSE:
            blended = sum(
                applied[name] * float(normalised[name].get(code, 0.0)) for name in usable
            )
            score = round(100.0 * blended, 1)

            probability = sum(
                applied[name] * float(rates[name].get(code, 0.0)) for name in usable
            )

            frequency_row = frequency_by_code[code]
            markov_row = markov_by_code.get(code)

            rankings.append(
                {
                    # --- RankEntry contract (src/data/mock.ts) -----------------
                    "code": code,
                    "probability": round(100.0 * probability, 3),
                    "score": score,
                    # `delta` is "change vs the previous model run". No run is
                    # stored yet — that arrives with the Day 5 draw-cycle job —
                    # so it is explicitly zero rather than fabricated movement.
                    "delta": 0.0,
                    "lastSeenDays": draws_since_last_seen(series, code),
                    # --- additive detail -------------------------------------
                    "tone": signal_tone(score),
                    "reason": build_reason(
                        frequency_row, markov_row, markov.usable, state, channel
                    ),
                    "evidence": {
                        "frequency": frequency_row.as_dict(),
                        "markov": markov_row.as_dict() if markov_row else None,
                    },
                }
            )

        # Strongest first; ties broken by code so repeated runs are byte-identical.
        rankings.sort(key=lambda item: (-item["score"], item["code"]))
    else:
        # Fewer than a handful of draws cannot rank anything. Returning no picks
        # is the honest answer; five arbitrary codes would look like a result.
        warnings.append(
            f"{channel}: only {draws} usable draw(s); at least {MIN_DRAWS_ANY} are "
            "needed before any ranking is meaningful, so no picks were produced."
        )

    if draws and draws < MIN_DRAWS_FREQUENCY:
        warnings.append(
            f"{channel}: only {draws} draw(s) analysed. Frequency ranks below "
            f"{MIN_DRAWS_FREQUENCY} draws are indicative only."
        )

    if markov.usable and markov.support < MIN_MARKOV_STRONG:
        warnings.append(
            f"{channel}: the Markov estimate for state {state} rests on only "
            f"{markov.support} observed transition(s), so its conditional "
            "probabilities are weak evidence and the scores should be read as "
            "frequency-driven."
        )

    return ChannelResult(
        channel=channel,
        current_state=state,
        draws=draws,
        weights=applied,
        frequencies=top_frequency(series, top_n),
        markov=markov,
        rankings=rankings[:top_n],
    )


# ---------------------------------------------------------------------------
# Top-level analysis
# ---------------------------------------------------------------------------


def analyse_draws(
    rows: Iterable[Mapping[str, Any]],
    *,
    smoothing: float = DEFAULT_SMOOTHING,
    weights: Mapping[str, float] | None = None,
    top_n: int = TOP_N,
) -> dict[str, Any]:
    """Run the Day 3 pipeline over raw ledger rows and return the API payload.

    Degrades instead of raising: an empty or tiny history produces a well-formed
    response with ``status`` set and every limitation listed in ``warnings``, so
    the client can render an empty state rather than an error.
    """
    frame, warnings = prepare_history(rows)

    latest: dict[str, Any] | None = None
    if not frame.empty:
        last_row = frame.iloc[-1]
        latest = {
            "draw_date": last_row["draw_date"].date().isoformat(),
            "first_prize": str(last_row["first_prize"]),
            "bottom_two": str(last_row["bottom_two"]),
        }

    channels: dict[str, Any] = {}
    for channel in CHANNELS:
        series = channel_series(frame, channel)
        channels[channel] = score_channel(
            series,
            channel,
            smoothing=smoothing,
            weights=weights,
            top_n=top_n,
            warnings=warnings,
        )

    total_draws = int(len(frame))
    if total_draws == 0:
        status = "insufficient_data"
        warnings.append(
            "No usable draws, so no prediction was produced. Seed the "
            "lottery_draws table with backend/scraper.py."
        )
    elif total_draws < MIN_DRAWS_ANY:
        status = "insufficient_data"
        warnings.append(
            f"Only {total_draws} draw(s) available; at least {MIN_DRAWS_ANY} are "
            "needed before any ranking is meaningful."
        )
    elif any(
        not channels[channel].markov.usable
        or channels[channel].markov.support < MIN_MARKOV_STRONG
        or total_draws < MIN_DRAWS_FREQUENCY
        for channel in CHANNELS
    ):
        # "limited" is the expected steady state for this dataset size, not an
        # edge case: see MIN_MARKOV_STRONG.
        status = "limited"
    else:
        status = "ok"

    return {
        "status": status,
        "draws_analyzed": total_draws,
        "date_range": {
            "from": frame["draw_date"].min().date().isoformat() if total_draws else None,
            "to": frame["draw_date"].max().date().isoformat() if total_draws else None,
        },
        "latest_draw": latest,
        "weights_configured": {
            key: round(float(value), 4)
            for key, value in (weights or DEFAULT_WEIGHTS).items()
        },
        "smoothing": smoothing,
        "tone_thresholds": {tone: threshold for threshold, tone in TONE_THRESHOLDS},
        "channels": {channel: channels[channel].as_dict() for channel in CHANNELS},
        "warnings": warnings,
        "methodology": METHODOLOGY_NOTE,
    }
