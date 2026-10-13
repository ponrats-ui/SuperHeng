"""SuperHeng — Day 5: Monte Carlo survival simulation.

What the simulation actually simulates
--------------------------------------
The naive reading of "run 100,000 simulated draws and count how often each number
comes up" describes something that cannot tell you anything: if each simulated
draw samples one code from the historical weights, the expected count per code is
just ``simulations * weight`` — the simulation would return the input back,
rescaled, and the ranking would be identical to the weights it started from.

What is informative is a simulation of the **whole selection**. Each simulation
draws a full ranked set of ``top_k`` distinct codes (without replacement) from the
weighted distribution, exactly as a draw selects a set of co-occurring numbers,
and a code is a **survivor** if it lands inside that simulated top-K. The
survival rate is then an empirical answer to *"how often does this code hold a
top-K place?"*, which is the question a top-5 product actually asks, and it is
not a restatement of the input: the survival rate of a code with weight ``w``
depends on how the other 99 codes compete with it, so the ordering can — and
does — differ from the raw weights.

This follows VISION §2.3: candidates "that persist across the greatest share of
simulations, and that occupy the top-K of each simulated draw, accumulate a
survival score".

How it is made fast and reproducible
------------------------------------
Sampling ``top_k`` distinct codes with probability proportional to weight is
Plackett-Luce sampling, and the Gumbel-max trick evaluates it in closed vector
form: adding independent Gumbel noise to ``log(weight)`` and taking the largest
values samples *without replacement* exactly, with no accept/reject loop and no
per-simulation Python. The whole simulation is therefore a handful of NumPy
operations over a ``(simulations, 100)`` block, processed in chunks so peak memory
stays bounded regardless of the simulation count.

The generator is seeded with an explicit, recorded, default-fixed seed, so a
published score can be reproduced byte for byte — the roadmap's reproducibility
requirement.

Both rates are reported, and they are different quantities:

``survival_rate``
    ``P(code is in the simulated top-K)``. This is the ensemble's signal.
``win_rate``
    ``P(code is the single highest-ranked simulated pick)``.

Neither is a per-draw probability of the actual lottery. ``survival_rate`` is
bounded by roughly ``top_k`` times a code's draw rate, so feeding it into a
"probability of appearing in the next draw" figure would overstate that by about
a factor of ``top_k``. The ensemble enforces that separation explicitly — see
``models.ensemble.PROBABILITY_SIGNALS``.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from services import NUMBER_UNIVERSE, TOP_N, UNIVERSE_SIZE

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# VISION §2.3 asks for 100,000+ per prediction cycle; the Day 5 request asks for
# at least 10,000. This satisfies both. The cost is measured in the roadmap.
DEFAULT_SIMULATIONS = 100_000

# A code "survives" by holding a place in the simulated top-K, matching the
# top-5 the app publishes.
DEFAULT_TOP_K = TOP_N

# Fixed by default so identical inputs give an identical score, and always
# echoed back in the response.
DEFAULT_SEED = 20261001

# Simulations per block. 20,000 x 100 float64 is ~16 MB, so peak memory stays
# flat whether the caller asks for 10,000 or 10,000,000.
DEFAULT_CHUNK = 20_000

# Keeps log() away from exactly 0 and 1 when generating Gumbel noise.
_EPSILON = 1e-12


@dataclass(frozen=True)
class MonteCarloResult:
    """Empirical survival and win rates from one simulation run."""

    channel: str | None
    simulations: int
    top_k: int
    seed: int
    weights: pd.Series
    survival_rate: pd.Series
    win_rate: pd.Series
    standard_error: pd.Series
    survival_counts: np.ndarray
    win_counts: np.ndarray
    elapsed_ms: float = 0.0
    normalised: bool = False
    usable: bool = True
    note: str = ""

    def distribution(self) -> pd.Series:
        """The survival rate per code — the signal the ensemble consumes."""
        return self.survival_rate

    def top(self, top_n: int = TOP_N) -> list[dict[str, Any]]:
        """The most frequent survivors, highest survival rate first."""
        ordered = sorted(NUMBER_UNIVERSE, key=lambda code: (-self.survival_rate[code], code))
        return [
            {
                "code": code,
                "survival_rate": round(float(self.survival_rate[code]), 6),
                "survival_count": int(self.survival_counts[NUMBER_UNIVERSE.index(code)]),
                "win_rate": round(float(self.win_rate[code]), 6),
                "standard_error": round(float(self.standard_error[code]), 6),
                "weight": round(float(self.weights[code]), 6),
            }
            for code in ordered[:top_n]
        ]

    def as_dict(self, top_n: int = TOP_N) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "model": "Monte Carlo",
            "usable": self.usable,
            "simulations": self.simulations,
            "top_k": self.top_k,
            "seed": self.seed,
            "elapsed_ms": round(self.elapsed_ms, 1),
            "weights_normalised": self.normalised,
            # Under weights uniform across 100 codes, every code survives the
            # top-K at exactly top_k / 100. Published so a survival rate can be
            # read against its no-signal baseline instead of in a vacuum.
            "uniform_survival_baseline": round(self.top_k / UNIVERSE_SIZE, 6),
            # Invariant: each of the `simulations` runs contributes exactly
            # `top_k` survivors, so these must be equal.
            "survival_assignments": int(self.survival_counts.sum()),
            "expected_assignments": self.simulations * self.top_k,
            "top_survivors": self.top(top_n),
            "note": self.note,
        }


def _normalise_weights(weights: pd.Series) -> tuple[pd.Series, bool]:
    """Align to the code universe, and scale to sum 1.

    Returns ``(weights, changed)``. The flag is reported so a caller can tell an
    already-normalised distribution from one this function had to rescale.
    """
    if not isinstance(weights, pd.Series):
        weights = pd.Series(weights, dtype="float64")

    # Recorded before alignment, so the flag means "the input was already the
    # distribution it claims to be" rather than "the arithmetic moved it".
    already_normalised = (
        len(weights) == UNIVERSE_SIZE
        and not weights.reindex(NUMBER_UNIVERSE).isna().any()
        and abs(float(weights.sum()) - 1.0) <= 1e-9
    )

    aligned = weights.reindex(NUMBER_UNIVERSE).astype("float64").clip(lower=0.0)
    # A code absent from the input cannot be drawn: log(0) is -inf, which is the
    # intended meaning, whereas NaN would be a bug. So the absence is explicit.
    aligned = aligned.fillna(0.0)

    total = float(aligned.sum())
    if total <= 0:
        raise ValueError("Monte Carlo weights must contain at least one positive value")

    return aligned / total, not already_normalised


def monte_carlo_survival(
    weights: pd.Series,
    *,
    channel: str | None = None,
    simulations: int = DEFAULT_SIMULATIONS,
    top_k: int = DEFAULT_TOP_K,
    seed: int = DEFAULT_SEED,
    chunk_size: int = DEFAULT_CHUNK,
) -> MonteCarloResult:
    """Simulate ``simulations`` draws and score how often each code survives.

    ``weights`` is the historical probability distribution over the 100 codes —
    in this pipeline the blended frequency/Markov (and later ARIMA) rate
    estimates, never a uniform draw, which is what makes the simulation reflect
    the modelled structure rather than noise.

    Deterministic for a given ``seed``. Raises ``ValueError`` only for input that
    cannot be simulated at all (no positive weight, or ``top_k`` larger than the
    universe).
    """
    started = time.perf_counter()

    if simulations < 1:
        raise ValueError("simulations must be at least 1")
    if not 1 <= top_k <= UNIVERSE_SIZE:
        raise ValueError(f"top_k must be between 1 and {UNIVERSE_SIZE}, got {top_k}")

    distribution, normalised = _normalise_weights(weights)

    weights_array = distribution.to_numpy(dtype="float64")
    # log(0) = -inf: a zero-weight code can never be drawn, which is correct and
    # avoids a NaN from 0 * inf downstream.
    with np.errstate(divide="ignore"):
        log_weights = np.where(weights_array > 0, np.log(weights_array), -np.inf)

    counts = len(weights_array)
    survival_counts = np.zeros(counts, dtype="int64")
    win_counts = np.zeros(counts, dtype="int64")

    generator = np.random.default_rng(seed)
    remaining = simulations
    while remaining > 0:
        block = min(chunk_size, remaining)
        remaining -= block

        uniform = generator.random((block, counts))
        # Clamp away from the open ends so log() never sees 0 or 1.
        np.clip(uniform, _EPSILON, 1.0 - _EPSILON, out=uniform)
        gumbel = -np.log(-np.log(uniform))
        scores = log_weights + gumbel

        # Gumbel-max: the top-k of (log w + Gumbel) is an exact draw of k codes
        # without replacement, weighted by w.
        selected = np.argpartition(-scores, top_k - 1, axis=1)[:, :top_k]
        winners = np.argmax(scores, axis=1)

        survival_counts += np.bincount(selected.ravel(), minlength=counts)
        win_counts += np.bincount(winners, minlength=counts)

    survival_rate = survival_counts / simulations
    win_rate = win_counts / simulations
    # Binomial standard error. Feeds the confidence label: a code with a good
    # mean but a wide interval is not a strong signal (VISION §2.3).
    standard_error = np.sqrt(survival_rate * (1.0 - survival_rate) / simulations)

    elapsed_ms = (time.perf_counter() - started) * 1000.0

    return MonteCarloResult(
        channel=channel,
        simulations=simulations,
        top_k=top_k,
        seed=seed,
        weights=distribution,
        survival_rate=pd.Series(survival_rate, index=list(NUMBER_UNIVERSE), dtype="float64"),
        win_rate=pd.Series(win_rate, index=list(NUMBER_UNIVERSE), dtype="float64"),
        standard_error=pd.Series(
            standard_error, index=list(NUMBER_UNIVERSE), dtype="float64"
        ),
        survival_counts=survival_counts,
        win_counts=win_counts,
        elapsed_ms=elapsed_ms,
        normalised=normalised,
        usable=simulations >= 1,
        note="",
    )
