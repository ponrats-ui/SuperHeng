/**
 * The 00-99 heatmap, computed as a real four-model ensemble.
 *
 * **What this replaces.** The previous grid was a hash of the cell index with the
 * ranked codes painted on top (`buildHeatmap` in `data/mock.ts`). It never changed,
 * it had no relationship to a draw, and every "probability" in it was decoration.
 * This module derives the grid from the published ledger instead, so a cell's colour
 * is a fact about the draws the app actually holds.
 *
 * **The blend.** Every model produces a full distribution over the 100 codes, and the
 * ensemble is their weighted mean:
 *
 *     p(code) = Σ wᵢ · pᵢ(code)         Σ wᵢ = 1
 *
 * **Where the weights come from.** They are refit from evidence rather than fixed at
 * 25% each. Each model is scored, walk-forward, on the last `HEATMAP_ACCURACY_WINDOW`
 * completed draws: for every one of those draws the model is fitted on the draws before
 * it and its log score for the code that actually came out is recorded. Mean log score
 * minus the uniform baseline is that model's recent **skill**. Every model keeps a 10%
 * floor so one lucky streak cannot erase the ensemble, and the remaining 60% is split
 * in proportion to skill, with a 40% ceiling per model so no single fit dominates.
 *
 * Two honest caveats. Ten draws is a short sample, which is exactly why the floor and
 * ceiling exist: without them a model that got lucky twice would take most of the
 * blend. And the weights are refit on the same ledger the replay scores them against,
 * so they are *adaptive*, not proven superior — `replayHeatmapSignals` still rebuilds
 * each historical board from the draws that preceded it, so no future outcome leaks
 * into the board it is scoring.
 *
 * **The score and the colour.** A cell's 0-100 score is its **percentile** on this board,
 * not a probability: `probability` (per-draw chance, in percent) and `lift` (chance ÷ the
 * 1% uniform rate) travel beside it, and the copy under the grid says what each number
 * means. Colour does **not** come from that score. Each cell carries a `tier` assigned by
 * **quota** — the top 12 codes are green, the next 18 gold, the next 30 red, the bottom
 * 40 grey — so the green band is a strict filter rather than a fraction of the grid that
 * moves with the shape of the board. Percentiles keep the grid legible (a true probability
 * grid is 0.3%–3% and every cell would look identical); the quota keeps "HIGH" rare.
 *
 * **Model definitions.** All four read the ledger's เลขท้าย 2 ตัว column (the separately
 * drawn 2-digit prize), never the tail of the first prize:
 *
 * - *Frequency* — how often the code appeared across the window, Laplace-smoothed so a
 *   code seen zero times is rare, not impossible.
 * - *Markov* — first-order transitions from the latest code, shrunk toward the
 *   frequency distribution. A 100-draw ledger holds roughly one observation of any
 *   given state, so the raw conditional would be a single transition masquerading as a
 *   probability; the shrinkage says so instead.
 * - *Momentum* — the last ten draws with exponential decay (half-life three draws),
 *   which is "hot/cold" expressed as a distribution rather than a label.
 * - *Monte Carlo* — 10,000 simulated next draws from a fitted AR(1) on each digit, with
 *   the residuals' measured correlation, rounding and clamping to 0-9. That is a
 *   mean-reverting process: the expected value is pulled back toward the long-run digit
 *   mean by the measured φ, and the spread is the measured residual standard deviation.
 *   The simulation is seeded from the ledger, so the same draws always produce the same
 *   grid — a heatmap that reshuffles on reload cannot be quoted by anyone.
 */

/** Every 2-digit code, in numeric order. */
export const HEATMAP_CODES: readonly string[] = Array.from({ length: 100 }, (_, index) =>
  String(index).padStart(2, '0')
);

/**
 * Every model in the blend, in the order the copy lists them.
 *
 * The order is also the order the per-model top picks are resolved in.
 */
export const HEATMAP_MODELS = ['markov', 'frequency', 'momentum', 'montecarlo'] as const;

export type HeatmapModel = (typeof HEATMAP_MODELS)[number];

/** Current allocation, one entry per model. Always sums to 1. */
export type HeatmapWeights = Record<HeatmapModel, number>;

/** Every model keeps at least this share, whatever its recent form. */
export const HEATMAP_MIN_WEIGHT = 0.1;

/** No single model may take more than this share of the blend. */
export const HEATMAP_MAX_WEIGHT = 0.4;

/** Completed draws each model is scored on before the weights are refit. */
export const HEATMAP_ACCURACY_WINDOW = 10;

/**
 * The board's four bands, strongest first.
 *
 * A band is a **fixed quota of the 100 codes**, not a cut-off on the score: the green
 * band is exactly the best 12 whatever the board looks like. That is deliberate — the
 * earlier score-threshold band put roughly a quarter of the grid in green, which read as
 * "most of the board is a signal" and told a reader nothing about where the edge was.
 * A quota is also immune to ties, which a threshold is not: a threshold can fall inside
 * a block of equal scores and colour half of them.
 *
 * The trade-off is worth stating plainly: a quota guarantees green cells even on a board
 * with no edge at all. Green therefore means "top of this board", never "likely to be
 * drawn".
 */
export const HEATMAP_TIERS = ['high', 'medium', 'low', 'ignore'] as const;

export type HeatmapTier = (typeof HEATMAP_TIERS)[number];

/**
 * Share of the 100 codes each band gets. The last band is the remainder, so the four
 * always sum to the whole grid even if these are tuned.
 *
 * These are the house's bands: green top 12%, gold the next 18%, red the next 30%, grey
 * the bottom 40%. The UI prints them from this table, so the legend cannot describe a
 * filtering the code does not apply.
 */
export const HEATMAP_BAND_SHARES: Record<Exclude<HeatmapTier, 'ignore'>, number> = {
  high: 0.12,
  medium: 0.18,
  low: 0.3,
};

/** How many codes each band holds. Whole numbers, summing to exactly 100. */
export const HEATMAP_BAND_COUNTS: Record<HeatmapTier, number> = (() => {
  const high = Math.round(HEATMAP_BAND_SHARES.high * HEATMAP_CODES.length);
  const medium = Math.round(HEATMAP_BAND_SHARES.medium * HEATMAP_CODES.length);
  const low = Math.round(HEATMAP_BAND_SHARES.low * HEATMAP_CODES.length);
  return { high, medium, low, ignore: HEATMAP_CODES.length - high - medium - low };
})();

/** Simulated paths per board. The copy quotes this number, so it is not a knob. */
export const HEATMAP_SIMULATIONS = 10_000;

/**
 * Fewer draws than this and the transition/momentum estimates are noise; the board is
 * withheld rather than drawn with authority it did not earn.
 */
export const MIN_HEATMAP_DRAWS = 10;

/** One published draw, newest first in every array this module takes. */
export type HeatmapDraw = { date: string; code: string };

export type HeatmapCell = {
  code: string;
  /** Percentile of the blend on this board, 0-100. Not a probability. */
  score: number;
  /** Position on this board, 1 = strongest. Always 1-100 with no ties broken. */
  rank: number;
  /** Which quota band this code landed in; this is what colours the cell. */
  tier: HeatmapTier;
  /** Per-draw chance in percent, from the blended distribution. */
  probability: number;
  /** Chance divided by the 1% uniform rate. */
  lift: number;
};

/** Each model's single strongest code, and the codes the grid paints green. */
export type HeatmapSignals = {
  /** Highest blended score. */
  top1: string;
  /** Five highest blended scores, best first. */
  top5: string[];
  /** Every code in the green band — the top `HEATMAP_BAND_COUNTS.high` of the board. */
  high: string[];
  markov: string;
  frequency: string;
  momentum: string;
  montecarlo: string;
};

/**
 * How one model has done recently, and the share the blend gave it.
 *
 * `skill` is mean log score over the uniform baseline: 0 is indistinguishable from
 * guessing, negative is worse than guessing. `rank` is the mean percentile the model
 * gave the code that actually came out — 50 is "middle of its board on average", 90 is
 * "usually near the top of its board".
 */
export type HeatmapModelForm = {
  model: HeatmapModel;
  /** Mean log score minus the uniform baseline, in nats. */
  skill: number;
  /** Mean percentile of the realised code on that model's own board, 0-100. */
  rank: number;
  /** Draws where the realised code was in the model's top five. */
  top5: number;
  /** Draws scored. Matches the accuracy window unless the ledger is shorter. */
  draws: number;
  /** The share this model carries on the board below. */
  weight: number;
};

export type HeatmapBoard = {
  /** All 100 cells, in numeric code order, ready for the grid. */
  cells: HeatmapCell[];
  /** Lookup by code. */
  byCode: Record<string, HeatmapCell>;
  /** Codes best first. */
  ranked: string[];
  signals: HeatmapSignals;
  sample: { draws: number; from: string; to: string; last: string };
  simulations: number;
  /** The allocation this board was built with. */
  weights: HeatmapWeights;
  /** Per-model recent form, the evidence the allocation rests on. */
  form: HeatmapModelForm[];
};

/** Which signal a draw's actual result matched. */
export type HeatmapSignalSource =
  | 'top1'
  | 'top5'
  | 'heatmap'
  | 'markov'
  | 'frequency'
  | 'momentum';

export type HeatmapHit = {
  source: HeatmapSignalSource;
  code: string;
  /** The actual code's percentile on the pre-draw board. */
  score: number;
};

export type HeatmapReplayRow = {
  date: string;
  actual: string;
  /** The actual code's percentile on the board built from the draws before it. */
  score: number;
  /** The strongest signal that caught it, if any. */
  hit: HeatmapHit | null;
};

const UNIFORM = 1 / HEATMAP_CODES.length;
// How much the smoothing pulls a model toward the long-run frequency. Both values are
// pseudo-draws, so they are comparable with the sample sizes they are added to.
const FREQUENCY_PRIOR = 0.5;
const MARKOV_PRIOR = 10;
const MOMENTUM_PRIOR = 2;
const MOMENTUM_WINDOW = 10;
const MOMENTUM_HALF_LIFE = 3;

/** Deterministic 32-bit PRNG (mulberry32), so a board is reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, used to seed the simulation from the ledger itself. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Box-Muller normal draw. Cached pairs would add state for no measurable gain here. */
function gaussian(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mean(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values: readonly number[], centre = mean(values)): number {
  if (!values.length) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - centre) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

type AutoRegression = {
  /** AR(1) coefficient, clamped to [0, 1] so the process is mean-reverting. */
  phi: number;
  /** Long-run mean of the series. */
  centre: number;
  /** Residual standard deviation, the simulation's shock size. */
  sd: number;
  /** Residuals, kept so the two digits' correlation can be measured. */
  residuals: number[];
};

/**
 * Fits `x(t) = centre + φ·(x(t-1) - centre) + ε` by OLS.
 *
 * A negative φ would mean the series oscillates around its mean *faster* than
 * independence allows; on digit data that is a small-sample artefact, so it is clamped
 * to zero. The residual spread is floored so a short, flat sample cannot collapse the
 * simulation onto a single path and report 10,000 identical draws as confidence.
 */
function fitAutoRegression(values: readonly number[]): AutoRegression {
  if (values.length < 3) {
    const centre = mean(values);
    return { phi: 0, centre, sd: Math.max(deviation(values, centre), 0.5), residuals: [] };
  }

  const previous = values.slice(0, -1);
  const next = values.slice(1);
  const previousMean = mean(previous);
  const nextMean = mean(next);
  const covariance = previous.reduce(
    (sum, value, index) => sum + (value - previousMean) * (next[index] - nextMean),
    0
  );
  const variance = previous.reduce((sum, value) => sum + (value - previousMean) ** 2, 0);
  const phi = variance > 0 ? Math.min(1, Math.max(0, covariance / variance)) : 0;

  const residuals = next.map(
    (value, index) => value - (nextMean + phi * (previous[index] - previousMean))
  );

  return {
    phi,
    centre: previousMean,
    sd: Math.max(deviation(residuals), 0.5),
    residuals,
  };
}

/** Pearson correlation, clamped, with a zero fallback when either series is flat. */
function correlation(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  if (length < 3) return 0;
  const left = a.slice(0, length);
  const right = b.slice(0, length);
  const leftDeviation = deviation(left);
  const rightDeviation = deviation(right);
  if (leftDeviation === 0 || rightDeviation === 0) return 0;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const covariance =
    left.reduce(
      (sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean),
      0
    ) / length;
  return Math.max(-1, Math.min(1, covariance / (leftDeviation * rightDeviation)));
}

/** Laplace-smoothed long-run frequency of each code. */
function frequencyModel(sequence: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of sequence) counts[code] = (counts[code] ?? 0) + 1;

  const result: Record<string, number> = {};
  for (const code of HEATMAP_CODES) {
    result[code] = ((counts[code] ?? 0) + FREQUENCY_PRIOR) / (sequence.length + 100 * FREQUENCY_PRIOR);
  }
  return result;
}

/**
 * First-order transitions out of the latest code, shrunk toward the long-run
 * frequency. The shrinkage weight is a prior, not a fudge: with one observed
 * transition, the answer stays close to "how often does this code appear anyway".
 */
function markovModel(
  sequence: readonly string[],
  frequency: Record<string, number>
): Record<string, number> {
  const state = sequence[sequence.length - 1];
  const transitions: Record<string, number> = {};
  let support = 0;
  for (let index = 1; index < sequence.length; index++) {
    if (sequence[index - 1] !== state) continue;
    transitions[sequence[index]] = (transitions[sequence[index]] ?? 0) + 1;
    support += 1;
  }

  const result: Record<string, number> = {};
  for (const code of HEATMAP_CODES) {
    result[code] =
      ((transitions[code] ?? 0) + MARKOV_PRIOR * frequency[code]) / (support + MARKOV_PRIOR);
  }
  return result;
}

/** Exponentially decayed appearances over the last ten draws. */
function momentumModel(
  sequence: readonly string[],
  frequency: Record<string, number>
): Record<string, number> {
  const window = sequence.slice(-MOMENTUM_WINDOW);
  const weights = window.map((_, offset) =>
    0.5 ** ((window.length - 1 - offset) / MOMENTUM_HALF_LIFE)
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  const decayed: Record<string, number> = {};
  window.forEach((code, index) => {
    decayed[code] = (decayed[code] ?? 0) + weights[index];
  });

  const result: Record<string, number> = {};
  for (const code of HEATMAP_CODES) {
    result[code] =
      ((decayed[code] ?? 0) + MOMENTUM_PRIOR * frequency[code]) / (totalWeight + MOMENTUM_PRIOR);
  }
  return result;
}

/**
 * 10,000 one-step-ahead draws from a bivariate AR(1) on the two digits.
 *
 * The digits are simulated jointly with the residuals' measured correlation rather than
 * independently, because a 2-digit prize is one draw: sampling the pair as two unrelated
 * digits would invent pairs the model never learned about. Results are rounded to the
 * nearest digit and clamped to 0-9, then counted into the 100 cells.
 */
function monteCarloModel(
  sequence: readonly string[],
  seed: number,
  simulations: number
): Record<string, number> {
  const tens = sequence.map((code) => Number(code[0]));
  const units = sequence.map((code) => Number(code[1]));

  const tensFit = fitAutoRegression(tens);
  const unitsFit = fitAutoRegression(units);
  const rho = correlation(tensFit.residuals, unitsFit.residuals);

  const lastTens = tens[tens.length - 1];
  const lastUnits = units[units.length - 1];
  const tensNext = tensFit.centre + tensFit.phi * (lastTens - tensFit.centre);
  const unitsNext = unitsFit.centre + unitsFit.phi * (lastUnits - unitsFit.centre);
  const independentScale = Math.sqrt(Math.max(0, 1 - rho * rho));

  const counts = new Int32Array(HEATMAP_CODES.length);
  const random = createRandom(seed);

  for (let path = 0; path < simulations; path++) {
    const shared = gaussian(random);
    const own = gaussian(random);
    const tensDraw = Math.round(tensNext + tensFit.sd * shared);
    const unitsDraw = Math.round(
      unitsNext + unitsFit.sd * (rho * shared + independentScale * own)
    );
    const tensDigit = Math.min(9, Math.max(0, tensDraw));
    const unitsDigit = Math.min(9, Math.max(0, unitsDraw));
    counts[tensDigit * 10 + unitsDigit] += 1;
  }

  const result: Record<string, number> = {};
  for (let index = 0; index < HEATMAP_CODES.length; index++) {
    result[HEATMAP_CODES[index]] =
      (counts[index] + FREQUENCY_PRIOR) / (simulations + 100 * FREQUENCY_PRIOR);
  }
  return result;
}

/** Percentile of every code within one distribution; ties share their midrank. */
function percentiles(values: Record<string, number>): Record<string, number> {
  const ascending = [...HEATMAP_CODES].sort((a, b) => values[a] - values[b]);
  const result: Record<string, number> = {};
  const last = ascending.length - 1;

  let start = 0;
  while (start <= last) {
    let end = start;
    while (end < last && values[ascending[end + 1]] === values[ascending[start]]) end += 1;
    const percentile = (100 * ((start + end) / 2)) / last;
    for (let index = start; index <= end; index++) result[ascending[index]] = percentile;
    start = end + 1;
  }
  return result;
}

/** The strongest code in one model's distribution, deterministic on ties. */
function argmax(values: Record<string, number>): string {
  let best = HEATMAP_CODES[0];
  for (const code of HEATMAP_CODES) {
    if (values[code] > values[best]) best = code;
  }
  return best;
}

type ModelDistributions = Record<HeatmapModel, Record<string, number>>;

/** Fits all four models on one sequence, oldest draw first. */
function fitModels(
  sequence: readonly string[],
  simulations: number,
  seed: number
): ModelDistributions {
  const frequency = frequencyModel(sequence);
  return {
    frequency,
    markov: markovModel(sequence, frequency),
    momentum: momentumModel(sequence, frequency),
    montecarlo: monteCarloModel(sequence, seed, simulations),
  };
}

/**
 * Seed a fit from the ledger itself, so the same draws always give the same board.
 *
 * @param draws Newest first; only the first row and the length are read.
 */
function seedFor(draws: readonly HeatmapDraw[]): number {
  return hashString(`${draws[0].date}|${draws[0].code}|${draws.length}`);
}

/**
 * Splits 100% of the blend across models from their recent skill.
 *
 * Every model is guaranteed `HEATMAP_MIN_WEIGHT` and none may exceed
 * `HEATMAP_MAX_WEIGHT`; whatever is left after the floors is divided in proportion to
 * skill. A model with zero or negative skill (no better than guessing) keeps only its
 * floor. If every model is at or below chance the blend falls back to equal shares,
 * because there is no evidence to prefer one over another.
 *
 * The ceiling is not cosmetic: on a ten-draw sample a single model can look dominant by
 * luck, and an uncapped proportional split would hand it most of the board.
 *
 * @param skill Per-model skill in nats (log score minus the uniform baseline).
 * @returns Weights in the same order, summing to 1 within floating-point error.
 */
export function allocateWeights(skill: readonly number[]): number[] {
  const count = skill.length;
  if (!count) return [];

  const positive = skill.map((value) => Math.max(0, value));
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return skill.map(() => 1 / count);

  const weights = skill.map(() => HEATMAP_MIN_WEIGHT);
  let pool = 1 - HEATMAP_MIN_WEIGHT * count;
  let open = positive
    .map((value, index) => (value > 0 ? index : -1))
    .filter((index) => index >= 0);

  // Water-filling: offer everyone still under the ceiling a proportional share of what
  // is left, and only accept the offer if nobody overflows. Capping on the fly would let
  // the first model in the list swallow the pool and leave an equally good model behind
  // it on the floor, so a round is either applied whole or not at all.
  while (pool > 1e-12 && open.length) {
    const openTotal = open.reduce((sum, index) => sum + positive[index], 0);
    const shares = open.map((index) => (pool * positive[index]) / openTotal);
    const overflows = open.some(
      (index, position) => weights[index] + shares[position] > HEATMAP_MAX_WEIGHT + 1e-12
    );

    if (!overflows) {
      open.forEach((index, position) => {
        weights[index] += shares[position];
      });
      pool = 0;
      break;
    }

    open.forEach((index, position) => {
      if (weights[index] + shares[position] > HEATMAP_MAX_WEIGHT + 1e-12) {
        pool -= HEATMAP_MAX_WEIGHT - weights[index];
        weights[index] = HEATMAP_MAX_WEIGHT;
      }
    });
    open = open.filter((index) => weights[index] < HEATMAP_MAX_WEIGHT - 1e-12);
  }

  // A model that took the whole pool can still leave a residue when it hits the ceiling
  // with nobody left to absorb it; spread that evenly, never past the cap.
  let residue = 1 - weights.reduce((sum, value) => sum + value, 0);
  while (residue > 1e-12) {
    const adjustable = weights
      .map((value, index) => (value < HEATMAP_MAX_WEIGHT - 1e-12 ? index : -1))
      .filter((index) => index >= 0);
    if (!adjustable.length) break;

    const share = residue / adjustable.length;
    for (const index of adjustable) {
      const addition = Math.min(share, HEATMAP_MAX_WEIGHT - weights[index]);
      weights[index] += addition;
      residue -= addition;
    }
  }

  return weights;
}

/**
 * Whole-number percentages for display, forced to sum to exactly 100.
 *
 * Rounding each weight independently can print 99% or 101%, which reads as a bug in a
 * sentence that says “each model's current weight”. Largest-remainder rounding keeps
 * the printed list and the arithmetic in agreement.
 */
export function weightPercents(weights: HeatmapWeights): Record<HeatmapModel, number> {
  const entries = HEATMAP_MODELS.map((model) => {
    const exact = weights[model] * 100;
    const whole = Math.floor(exact + 1e-9);
    return { model, whole, fraction: exact - whole };
  });

  let remainder = 100 - entries.reduce((sum, entry) => sum + entry.whole, 0);
  const byFraction = [...entries].sort((a, b) => b.fraction - a.fraction);
  for (const entry of byFraction) {
    if (remainder <= 0) break;
    entry.whole += 1;
    remainder -= 1;
  }

  const result = {} as Record<HeatmapModel, number>;
  for (const entry of entries) result[entry.model] = entry.whole;
  return result;
}

/**
 * Scores each model on the last `HEATMAP_ACCURACY_WINDOW` completed draws.
 *
 * Each scored draw gets a board fitted only on the draws before it, so the "form" the
 * weights are based on is genuine out-of-sample form, not each model's fit to the whole
 * ledger. Log score is used because it is a proper scoring rule: it rewards assigning
 * honest probability to the outcome, and it cannot be gamed by spreading mass evenly the
 * way accuracy-of-top-pick can.
 */
function estimateForm(
  draws: readonly HeatmapDraw[],
  simulations: number
): HeatmapModelForm[] {
  const tally = HEATMAP_MODELS.map((model) => ({ model, skill: 0, rank: 0, top5: 0 }));
  const limit = Math.min(HEATMAP_ACCURACY_WINDOW, Math.max(0, draws.length - 1));
  let scored = 0;

  for (let index = 0; index < limit; index++) {
    const target = draws[index];
    const history = draws.slice(index + 1);
    // Newest-first slicing only removes history as the target gets older, so one thin
    // window means every later target is thinner still.
    if (history.length < MIN_HEATMAP_DRAWS) break;

    const sequence = [...history].reverse().map((draw) => draw.code);
    const models = fitModels(sequence, simulations, seedFor(history));
    scored += 1;

    for (const row of tally) {
      const distribution = models[row.model];
      // ln p − ln(1/100): positive means the model did better than a uniform guess.
      row.skill += Math.log(Math.max(distribution[target.code], 1e-12)) + Math.log(100);
      row.rank += percentiles(distribution)[target.code];

      const best = [...HEATMAP_CODES]
        .sort((a, b) => distribution[b] - distribution[a] || (a < b ? -1 : 1))
        .slice(0, 5);
      if (best.includes(target.code)) row.top5 += 1;
    }
  }

  const weights = allocateWeights(tally.map((row) => row.skill));

  return tally.map((row, index) => ({
    model: row.model,
    skill: scored ? row.skill / scored : 0,
    rank: scored ? row.rank / scored : 0,
    top5: row.top5,
    draws: scored,
    weight: weights[index],
  }));
}

/**
 * Builds the board for the **next** draw from the ledger before it.
 *
 * @param draws Published draws, **newest first** — the order `/api/latest-draws`
 * returns. The newest row is the state the Markov and AR(1) steps condition on.
 * @returns The board, or `null` when the window is too thin to mean anything.
 */
export function buildHeatmapBoard(
  draws: readonly HeatmapDraw[],
  simulations: number = HEATMAP_SIMULATIONS
): HeatmapBoard | null {
  const usable = draws.filter((draw) => /^\d{2}$/.test(draw.code));
  if (usable.length < MIN_HEATMAP_DRAWS) return null;

  const sequence = [...usable].reverse().map((draw) => draw.code);

  // Recent form first, then the board itself: the weights are evidence from draws that
  // are already published, so nothing below can see the draw it is predicting.
  const form = estimateForm(usable, simulations);
  const weights = {} as HeatmapWeights;
  for (const row of form) weights[row.model] = row.weight;

  const models = fitModels(sequence, simulations, seedFor(usable));

  const blended: Record<string, number> = {};
  for (const code of HEATMAP_CODES) {
    blended[code] = HEATMAP_MODELS.reduce(
      (sum, model) => sum + weights[model] * models[model][code],
      0
    );
  }

  const score = percentiles(blended);
  const ranked = [...HEATMAP_CODES].sort((a, b) => blended[b] - blended[a] || (a < b ? -1 : 1));

  // Bands are filled by position, best first. The sort above breaks ties by code, so
  // every cell gets exactly one band and the counts are the constants, not an accident
  // of where two equal scores happened to land.
  const tierByCode: Record<string, HeatmapTier> = {};
  const rankByCode: Record<string, number> = {};
  let position = 0;
  for (const tier of HEATMAP_TIERS) {
    for (let step = 0; step < HEATMAP_BAND_COUNTS[tier] && position < ranked.length; step++) {
      tierByCode[ranked[position]] = tier;
      rankByCode[ranked[position]] = position + 1;
      position += 1;
    }
  }

  const cells: HeatmapCell[] = HEATMAP_CODES.map((code) => ({
    code,
    score: Math.round(score[code] * 10) / 10,
    rank: rankByCode[code],
    tier: tierByCode[code],
    probability: Math.round(blended[code] * 100_000) / 1_000,
    lift: Math.round((blended[code] / UNIFORM) * 100) / 100,
  }));
  const byCode: Record<string, HeatmapCell> = {};
  for (const cell of cells) byCode[cell.code] = cell;

  return {
    cells,
    byCode,
    ranked,
    signals: {
      top1: ranked[0],
      top5: ranked.slice(0, 5),
      high: ranked.filter((code) => tierByCode[code] === 'high'),
      markov: argmax(models.markov),
      frequency: argmax(models.frequency),
      momentum: argmax(models.momentum),
      montecarlo: argmax(models.montecarlo),
    },
    sample: {
      draws: sequence.length,
      from: usable[usable.length - 1].date,
      to: usable[0].date,
      last: sequence[sequence.length - 1],
    },
    simulations,
    weights,
    form,
  };
}

/**
 * Which signal, if any, called a result.
 *
 * Priority is by strength of claim, not by convenience: the blend's #1 beats a top-five
 * membership, which beats being painted green, which beats one model's single pick. The
 * tag the UI prints is therefore the strongest thing that is true, never the most
 * flattering one that is also technically true.
 */
export function hitFor(
  board: HeatmapBoard,
  actual: string
): HeatmapHit | null {
  const cell = board.byCode[actual];
  if (!cell) return null;
  const { signals } = board;

  if (actual === signals.top1) return { source: 'top1', code: actual, score: cell.score };
  if (signals.top5.includes(actual)) return { source: 'top5', code: actual, score: cell.score };
  if (cell.tier === 'high') {
    return { source: 'heatmap', code: actual, score: cell.score };
  }
  if (actual === signals.markov) return { source: 'markov', code: actual, score: cell.score };
  if (actual === signals.frequency) {
    return { source: 'frequency', code: actual, score: cell.score };
  }
  if (actual === signals.momentum) return { source: 'momentum', code: actual, score: cell.score };
  return null;
}

/**
 * Replays the last `count` draws through the heatmap, using only their own past.
 *
 * This is the claim the marketing card and the history rows rest on, and it is a
 * **replay**, not a record: the app never stored a board before a draw, so each board
 * here is rebuilt from the draws that preceded its target. Same walk-forward rule as
 * the Backtest tab — the newest draw's board is built without the newest draw.
 *
 * @returns Rows newest first. A target whose prior history is thinner than
 * `MIN_HEATMAP_DRAWS` is omitted rather than scored on a board that could not be built.
 */
export function replayHeatmapSignals(
  draws: readonly HeatmapDraw[],
  count: number
): HeatmapReplayRow[] {
  const rows: HeatmapReplayRow[] = [];
  const limit = Math.min(count, draws.length - 1);

  for (let index = 0; index < limit; index++) {
    const target = draws[index];
    if (!/^\d{2}$/.test(target.code)) continue;
    const board = buildHeatmapBoard(draws.slice(index + 1));
    if (!board) break;

    const cell = board.byCode[target.code];
    rows.push({
      date: target.date,
      actual: target.code,
      score: cell.score,
      hit: hitFor(board, target.code),
    });
  }

  return rows;
}
