"""SuperHeng — Premium: Bayesian positional model for the 6-digit first prize.

What this models, and why
-------------------------
The 6-digit รางวัลที่ 1 is a sequence of six digits, and a **per-position** model
is the honest way to attack it: with ~400 draws against 10^6 possible numbers, an
end-to-end model has nothing to learn, but the ten outcomes of a *single* position
are each observed ~40 times. That is enough to estimate a distribution. This is
exactly the "structured decomposition — per-digit-position models" the ROADMAP's
6-digit tier calls for, and it is why the free tier's 2-digit ensemble is not
simply copied here.

All six positions are modelled, left to right:

=====================  =====  ==============  ===============================
key                    index  Thai            meaning
=====================  =====  ==============  ===============================
``hundred_thousands``  0      หลักแสน         hundred-thousands (leading digit)
``ten_thousands``      1      หลักหมื่น        ten-thousands place
``thousands``          2      หลักพัน         thousands place
``hundreds``           3      หลักร้อย        hundreds place
``tens``               4      หลักสิบ         tens place
``units``              5      หลักหน่วย       units place
=====================  =====  ==============  ===============================

The leading digit is the one position with **no higher neighbour**, so it is
published on its marginal alone (``basis == "marginal"``, ``conditioned_on ==
null``). A six-digit first prize may begin with 0, so all ten digits are possible
there and nothing is truncated.

The Bayesian part
-----------------
Both posteriors are closed-form Dirichlet-multinomial posterior means — no
sampler, no approximation. The conditional is computed for the five positions
that have a higher neighbour; the leading digit publishes the marginal, which is
all the evidence there is for it:

``marginal``
    ``P(digit | position)`` under a uniform ``Dirichlet(alpha)`` prior::

        (count[digit] + alpha) / (draws + 10 * alpha)

    ``alpha = 1`` is the Laplace/uniform prior, so an unseen digit is assigned
    ``1 / (draws + 10)`` instead of zero. This is the same add-k philosophy as the
    Day 3 Markov chain in ``services.py``, kept deliberately consistent.

``conditional``
    ``P(digit | position, higher-digit = x)``, the Premium signal. The prior for
    each conditioning row is **the position's own marginal**, not a flat uniform::

        (joint[x, digit] + k * marginal[digit]) / (row_total[x] + k)

    This is an empirical-Bayes hierarchy. A row with plenty of observations is
    driven almost entirely by its own counts, while a thin row shrinks back
    toward the marginal instead of inventing structure — which is the correct
    behaviour for "we have barely seen this state", and it means an unvisited
    state returns the marginal exactly rather than a spurious spike.

Ranking
-------
Each position's top-N (default 3) digits are ranked by the **conditional**
posterior given the *latest observed draw's* adjacent higher digit — the same
"condition on the most recent state" convention Day 3's Markov step uses. When
that state has fewer than ``min_support`` historical draws, the conditional
estimate is not evidence, so the position falls back to the marginal and says so;
the response never presents a thin conditional as if it were strong. The leading
digit has no such state, so it is always ranked on its marginal and reports
``conditioned_on`` as ``null``.

Honesty constraints (VISION.md §2.5, §5)
----------------------------------------
* The draw is fair and independent. Positional structure found here is a property
  of the sample and may be entirely noise — in particular, a positive "lift" over
  the marginal is *expected* from sampling alone and is not evidence of dependence.
* The reported numbers are model probabilities, never a chance of winning. Every
  position publishes its support so a reader can weigh them.
* Every reason string is assembled from the computed counts; nothing is invented.

Only ``pandas`` (already a dependency) and the standard library are used.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping

import pandas as pd

# The 2-digit models' sample floors are reused rather than re-declared: they mean
# the same thing here (below `MIN_DRAWS_ANY` nothing is computable; below
# `MIN_DRAWS_FREQUENCY` a frequency rank is indicative only; `MIN_MARKOV_SUPPORT`
# is the floor under which a conditional estimate is not evidence).
from services import MIN_DRAWS_ANY, MIN_DRAWS_FREQUENCY, MIN_MARKOV_SUPPORT

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DIGITS: tuple[str, ...] = tuple(str(digit) for digit in range(10))
UNIVERSE_SIZE = len(DIGITS)

# Top 3 per position, per the Premium feature's contract.
DEFAULT_TOP_N = 3

# Uniform Dirichlet prior for the marginal posterior (Laplace's rule of
# succession). 1.0 keeps an unseen digit at 1/(draws + 10), never at zero.
DEFAULT_PRIOR_ALPHA = 1.0

# Pseudo-count strength of the marginal prior inside each conditional row. 1.0 is
# a light shrink: a state observed a few hundred times is almost untouched, an
# unvisited state snaps back to the marginal.
DEFAULT_PSEUDOCOUNT = 1.0

# Fewer historical draws than this after a given higher-digit state, and the
# conditional distribution for that state is reported but not trusted.
DEFAULT_MIN_SUPPORT = MIN_MARKOV_SUPPORT

METHODOLOGY_NOTE = (
    "Per-position Bayesian posteriors over the six digits of รางวัลที่ 1. The "
    "marginal is a Dirichlet-posterior mean under a uniform prior; the premium "
    "conditional shrinks each (higher digit -> digit) row toward that marginal. "
    "The leading digit has no higher position to condition on, so it is published "
    "on its marginal alone. These are model probabilities about historical "
    "behaviour, not a chance of winning: a fair draw is independent, and any "
    "positional lift observed here may be entirely sampling noise."
)


@dataclass(frozen=True)
class PositionSpec:
    """One modelled position, plus the adjacent higher position it conditions on.

    The ``higher_*`` fields are ``None`` for the leading digit, which has nothing
    to its left to condition on — see :attr:`conditioned`.
    """

    name: str
    label: str
    plain: str  # human-readable name for reason strings
    index: int
    higher_name: str | None = None
    higher_plain: str | None = None
    higher_index: int | None = None

    @property
    def conditioned(self) -> bool:
        """True when there is a higher position to condition on."""
        return self.higher_index is not None


# Index 0 is the leading digit (hundred-thousands), index 5 the units digit. All
# six digits are targets, ordered left to right so the payload reads in the same
# direction as the prize string. Every position but the leading digit has a
# well-populated higher neighbour; the leading digit is published on its marginal
# because there is nothing above it to condition on.
POSITIONS: tuple[PositionSpec, ...] = (
    PositionSpec(
        name="hundred_thousands",
        label="Hundred-thousands (หลักแสน)",
        plain="hundred-thousands",
        index=0,
    ),
    PositionSpec(
        name="ten_thousands",
        label="Ten-thousands (หลักหมื่น)",
        plain="ten-thousands",
        index=1,
        higher_name="hundred_thousands",
        higher_plain="hundred-thousands",
        higher_index=0,
    ),
    PositionSpec(
        name="thousands",
        label="Thousands (หลักพัน)",
        plain="thousands",
        index=2,
        higher_name="ten_thousands",
        higher_plain="ten-thousands",
        higher_index=1,
    ),
    PositionSpec(
        name="hundreds",
        label="Hundreds (หลักร้อย)",
        plain="hundreds",
        index=3,
        higher_name="thousands",
        higher_plain="thousands",
        higher_index=2,
    ),
    PositionSpec(
        name="tens",
        label="Tens (หลักสิบ)",
        plain="tens",
        index=4,
        higher_name="hundreds",
        higher_plain="hundreds",
        higher_index=3,
    ),
    PositionSpec(
        name="units",
        label="Units (หลักหน่วย)",
        plain="units",
        index=5,
        higher_name="tens",
        higher_plain="tens",
        higher_index=4,
    ),
)

POSITION_NAMES: tuple[str, ...] = tuple(spec.name for spec in POSITIONS)


# ---------------------------------------------------------------------------
# Data preparation
# ---------------------------------------------------------------------------


def _prepare_prizes(
    rows: Iterable[Mapping[str, Any]],
) -> tuple[list[tuple[str, str]], list[str]]:
    """Turn raw ``lottery_draws`` rows into a chronological list of first prizes.

    Returns ``(prizes, warnings)`` where each entry is ``(draw_date_iso, prize)``,
    sorted **oldest first** so "the latest draw" is simply the last entry. Unlike
    the 2-digit preparation, only ``first_prize`` is needed here, so a row that is
    valid as a 6-digit first prize is kept even if ``bottom_two`` is absent.

    Rows are never silently dropped: anything discarded is counted and reported.
    """
    warnings: list[str] = []

    if not rows:
        return [], ["No draw rows were supplied."]

    frame = pd.DataFrame(list(rows))
    for column in ("draw_date", "first_prize"):
        if column not in frame.columns:
            raise ValueError(f"draw rows are missing the required column {column!r}")

    frame["draw_date"] = pd.to_datetime(frame["draw_date"], errors="coerce")
    malformed_dates = int(frame["draw_date"].isna().sum())
    if malformed_dates:
        warnings.append(f"Dropped {malformed_dates} row(s) with an unparseable draw_date.")
        frame = frame[frame["draw_date"].notna()]

    cleaned = frame["first_prize"].astype("string").str.strip()
    valid = cleaned.str.fullmatch(r"[0-9]{6}").fillna(False).astype(bool)
    invalid = int((~valid).sum())
    if invalid:
        warnings.append(
            f"Dropped {invalid} row(s) whose first_prize was not exactly 6 digits."
        )
    frame = frame[valid]

    # Newest-first input (as the query returns it) becomes oldest-first, ties
    # broken stably so the ordering is deterministic for identical inputs.
    frame = frame.sort_values("draw_date", kind="stable")

    prizes = [
        (row.draw_date.date().isoformat(), str(row.first_prize))
        for row in frame.itertuples()
    ]
    return prizes, warnings


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DigitEstimate:
    """One candidate digit at one position, with the evidence behind it."""

    digit: str
    probability: float  # the posterior used for ranking, 0.0-1.0
    marginal: float  # P(digit | position)
    lift: float  # probability / marginal
    count: int  # raw supporting draws for the basis used
    support: int  # raw draws available for the conditioning state
    basis: str  # "conditional" | "marginal"
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "digit": self.digit,
            "probability": round(self.probability, 6),
            "marginal": round(self.marginal, 6),
            "lift": round(self.lift, 4),
            "count": self.count,
            "support": self.support,
            "basis": self.basis,
            "reason": self.reason,
        }


class BayesianPositionalModel:
    """Positional Dirichlet posteriors over the 6-digit first prize.

    The model is pure over its inputs — it is handed the draw rows and owns no
    database access — so it can be unit-tested without a Supabase client, exactly
    like the ARIMA and Monte Carlo models beside it. The endpoint fetches the rows
    through the shared client and passes them in.

    ``prizes`` is an iterable of 6-digit strings in **chronological order** (oldest
    first); the last entry is treated as the most recent draw.
    """

    def __init__(
        self,
        prizes: Iterable[str],
        *,
        prior_alpha: float = DEFAULT_PRIOR_ALPHA,
        pseudocount: float = DEFAULT_PSEUDOCOUNT,
        min_support: int = DEFAULT_MIN_SUPPORT,
        top_n: int = DEFAULT_TOP_N,
    ) -> None:
        if prior_alpha <= 0:
            raise ValueError("prior_alpha must be positive")
        if pseudocount <= 0:
            raise ValueError("pseudocount must be positive")
        if min_support < 0:
            raise ValueError("min_support must be non-negative")
        if top_n < 1:
            raise ValueError("top_n must be at least 1")

        self.prizes: list[str] = [str(prize).strip() for prize in prizes]
        self.draws: int = len(self.prizes)
        self.prior_alpha = float(prior_alpha)
        self.pseudocount = float(pseudocount)
        self.min_support = int(min_support)
        self.top_n = int(top_n)
        self.latest: str | None = self.prizes[-1] if self.prizes else None

        self.marginal_counts: dict[str, dict[str, int]] = {}
        self.joint_counts: dict[str, dict[str, dict[str, int]]] = {}
        self.row_counts: dict[str, dict[str, int]] = {}
        self.marginal_posterior: dict[str, dict[str, float]] = {}
        self.conditional_posterior: dict[str, dict[str, dict[str, float]]] = {}
        self._fit()

    # -- fitting ----------------------------------------------------------
    def _fit(self) -> None:
        """Count observations and compute both closed-form posteriors."""
        for spec in POSITIONS:
            self.marginal_counts[spec.name] = {digit: 0 for digit in DIGITS}
            self.row_counts[spec.name] = {digit: 0 for digit in DIGITS}
            self.joint_counts[spec.name] = {
                higher: {digit: 0 for digit in DIGITS} for higher in DIGITS
            }

        for prize in self.prizes:
            for spec in POSITIONS:
                digit = prize[spec.index]
                self.marginal_counts[spec.name][digit] += 1
                higher_index = spec.higher_index
                if higher_index is None:
                    # The leading digit has no higher neighbour, so there is no row
                    # to count it into: its marginal is its whole story.
                    continue
                higher = prize[higher_index]
                self.row_counts[spec.name][higher] += 1
                self.joint_counts[spec.name][higher][digit] += 1

        for spec in POSITIONS:
            # Marginal posterior — uniform Dirichlet prior over the ten digits.
            denominator = self.draws + UNIVERSE_SIZE * self.prior_alpha
            if denominator <= 0:
                marginal = {digit: 1.0 / UNIVERSE_SIZE for digit in DIGITS}
            else:
                marginal = {
                    digit: (self.marginal_counts[spec.name][digit] + self.prior_alpha)
                    / denominator
                    for digit in DIGITS
                }
            self.marginal_posterior[spec.name] = marginal

            # Conditional posterior — the position's own marginal is the prior for
            # each row, so a thin row shrinks toward it instead of to uniform. The
            # leading digit has no rows, so it keeps an empty mapping: `predict`
            # reads the marginal for it rather than pretending a conditional exists.
            conditional: dict[str, dict[str, float]] = {}
            if not spec.conditioned:
                self.conditional_posterior[spec.name] = conditional
                continue
            for higher in DIGITS:
                row_total = self.row_counts[spec.name][higher]
                row_denominator = row_total + self.pseudocount
                conditional[higher] = {
                    digit: (
                        self.joint_counts[spec.name][higher][digit]
                        + self.pseudocount * marginal[digit]
                    )
                    / row_denominator
                    for digit in DIGITS
                }
            self.conditional_posterior[spec.name] = conditional

    # -- inference --------------------------------------------------------
    def _no_history(
        self, spec: PositionSpec, digit: str, posterior: Mapping[str, float]
    ) -> DigitEstimate:
        """The single estimate shape used when there is no history to rank on."""
        marginal = self.marginal_posterior[spec.name][digit]
        probability = float(posterior[digit])
        return DigitEstimate(
            digit=digit,
            probability=probability,
            marginal=marginal,
            lift=(probability / marginal) if marginal else 0.0,
            count=0,
            support=0,
            basis="marginal",
            reason="No draw history, so no positional estimate is available.",
        )

    def _estimate(
        self,
        spec: PositionSpec,
        digit: str,
        posterior: Mapping[str, float],
        usable: bool,
        state: str | None,
        support: int,
    ) -> DigitEstimate:
        """Assemble one digit's estimate and its math-derived reason string."""
        marginal = self.marginal_posterior[spec.name][digit]
        probability = float(posterior[digit])
        lift = (probability / marginal) if marginal else 0.0

        if not spec.conditioned:
            # The leading digit is ranked on its marginal, and the reason has to say
            # that this *is* the whole basis rather than that a thin conditional was
            # abandoned — there is no higher position, so nothing was shrunk.
            if self.latest is None:
                return self._no_history(spec, digit, posterior)
            count = self.marginal_counts[spec.name][digit]
            reason = (
                f"The {spec.plain} digit is the leading digit, so no higher position "
                f"can condition it: it is ranked on the marginal, where {digit} "
                f"appears in {count} of {self.draws} draws "
                f"({probability * 100:.1f}%)."
            )
            return DigitEstimate(
                digit=digit,
                probability=probability,
                marginal=marginal,
                lift=lift,
                count=count,
                support=self.draws,
                basis="marginal",
                reason=reason,
            )

        if state is None:
            return self._no_history(spec, digit, posterior)

        if usable:
            count = self.joint_counts[spec.name][state][digit]
            reason = (
                f"After a {spec.higher_plain} digit of {state}, the {spec.plain} "
                f"digit is {digit} in {count} of {support} historical draws "
                f"({probability * 100:.1f}% posterior vs {marginal * 100:.1f}% "
                f"marginal, {lift:.2f}x)."
            )
            return DigitEstimate(
                digit=digit,
                probability=probability,
                marginal=marginal,
                lift=lift,
                count=count,
                support=support,
                basis="conditional",
                reason=reason,
            )

        count = self.marginal_counts[spec.name][digit]
        reason = (
            f"Only {support} historical draw(s) follow a {spec.higher_plain} digit "
            f"of {state} (need {self.min_support}), so this is ranked on the "
            f"marginal: {digit} appears in {count} of {self.draws} draws "
            f"({probability * 100:.1f}%)."
        )
        return DigitEstimate(
            digit=digit,
            probability=probability,
            marginal=marginal,
            lift=lift,
            count=count,
            support=support,
            basis="marginal",
            reason=reason,
        )

    def predict(self) -> dict[str, Any]:
        """Top-N digits per position, keyed by position name (e.g. ``"tens"``).

        Each position ranks by the conditional posterior given the latest draw's
        adjacent higher digit when that state has enough support, and by the
        marginal otherwise. The full posterior it ranked on is published as
        ``distribution`` so a caller can render the whole bar, not just the top 3.
        """
        results: dict[str, Any] = {}

        for spec in POSITIONS:
            higher_index = spec.higher_index
            state = (
                self.latest[higher_index]
                if self.latest and higher_index is not None
                else None
            )
            if spec.conditioned:
                support = (
                    self.row_counts[spec.name].get(state, 0)
                    if state is not None
                    else 0
                )
                usable = bool(state is not None and support >= self.min_support)
                posterior = (
                    self.conditional_posterior[spec.name][state]
                    if usable and state is not None
                    else self.marginal_posterior[spec.name]
                )
            else:
                # No row that can be too thin, and every draw informs the marginal,
                # so the leading digit is usable as soon as there is any history.
                support = self.draws
                usable = self.draws > 0
                posterior = self.marginal_posterior[spec.name]
            # `usable` and `basis` answer different questions: a leading-digit
            # marginal was never a fallback, only a conditioned position can be.
            basis = "conditional" if spec.conditioned and usable else "marginal"

            ordered = sorted(DIGITS, key=lambda item: (-posterior[item], item))
            top = [
                self._estimate(spec, digit, posterior, usable, state, support).as_dict()
                for digit in ordered[: self.top_n]
            ]

            results[spec.name] = {
                "name": spec.name,
                "label": spec.label,
                "index": spec.index,
                "conditioned_on": spec.higher_name,
                "conditioned_digit": state,
                "support": support,
                "usable": usable,
                "basis": basis,
                "distribution": {
                    digit: round(posterior[digit], 6) for digit in DIGITS
                },
                "marginal_distribution": {
                    digit: round(self.marginal_posterior[spec.name][digit], 6)
                    for digit in DIGITS
                },
                "top": top,
            }

        return results

    def as_dict(self, top_n: int | None = None) -> dict[str, Any]:
        """The model's output with a small header, for callers wanting both."""
        positions = self.predict()
        if top_n is not None and top_n != self.top_n:
            for payload in positions.values():
                payload["top"] = payload["top"][:top_n]
        return {
            "model": "bayesian_positional",
            "draws_analyzed": self.draws,
            "latest_prize": self.latest,
            "positions": positions,
        }


# ---------------------------------------------------------------------------
# Top-level analysis — the API payload
# ---------------------------------------------------------------------------


def analyse_positions(
    rows: Iterable[Mapping[str, Any]],
    *,
    prior_alpha: float = DEFAULT_PRIOR_ALPHA,
    pseudocount: float = DEFAULT_PSEUDOCOUNT,
    min_support: int = DEFAULT_MIN_SUPPORT,
    top_n: int = DEFAULT_TOP_N,
) -> dict[str, Any]:
    """Run the positional model over raw ledger rows and build the API payload.

    Degrades instead of raising, exactly as ``services.analyse_draws`` does: an
    empty or tiny ledger produces a well-formed response with ``status`` set and
    every limitation listed in ``warnings``, so the client can render an empty
    state rather than an error page.
    """
    prizes, warnings = _prepare_prizes(rows)
    draws = len(prizes)

    model = BayesianPositionalModel(
        [prize for _, prize in prizes],
        prior_alpha=prior_alpha,
        pseudocount=pseudocount,
        min_support=min_support,
        top_n=top_n,
    )
    # Below the floor nothing is computable, and five arbitrary digits would read
    # as a result rather than an absence — so no picks are published, matching
    # `services.analyse_draws`.
    positions = model.predict() if draws >= MIN_DRAWS_ANY else {}

    latest: dict[str, Any] | None = None
    if prizes:
        latest = {"draw_date": prizes[-1][0], "first_prize": prizes[-1][1]}

    if draws == 0:
        status = "insufficient_data"
        warnings.append(
            "No usable draws, so no positional prediction was produced. Seed the "
            "lottery_draws table with backend/scraper.py."
        )
    elif draws < MIN_DRAWS_ANY:
        status = "insufficient_data"
        warnings.append(
            f"Only {draws} draw(s) available; at least {MIN_DRAWS_ANY} are needed "
            "before any positional ranking is meaningful."
        )
    elif draws < MIN_DRAWS_FREQUENCY or any(
        not payload["usable"] for payload in positions.values()
    ):
        # "limited" signals that the picks exist but rest on a thin conditional
        # row (or a short ledger) rather than on solid evidence. The per-position
        # `basis` field says which, and the warnings below name the states.
        status = "limited"
        if draws < MIN_DRAWS_FREQUENCY:
            warnings.append(
                f"Only {draws} draw(s) analysed. Positional estimates below "
                f"{MIN_DRAWS_FREQUENCY} draws are indicative only."
            )
        for payload in positions.values():
            if not payload["usable"]:
                warnings.append(
                    f"{payload['name']}: the conditioning state "
                    f"{payload['conditioned_digit']} has only "
                    f"{payload['support']} draw(s) (need {min_support}), so this "
                    "position fell back to its marginal distribution."
                )
    else:
        status = "ok"

    return {
        "status": status,
        "model": "bayesian_positional",
        "draws_analyzed": draws,
        "date_range": {
            "from": prizes[0][0] if prizes else None,
            "to": prizes[-1][0] if prizes else None,
        },
        "latest_draw": latest,
        "prior_alpha": prior_alpha,
        "pseudocount": pseudocount,
        "min_support": min_support,
        "top_n": top_n,
        "positions": positions,
        "warnings": warnings,
        "methodology": METHODOLOGY_NOTE,
    }
