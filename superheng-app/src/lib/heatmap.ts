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
 *     p(code) = 0.25·Markov + 0.25·Frequency + 0.25·Momentum + 0.25·Monte Carlo
 *
 * Weights are equal on purpose: they are the house's stated allocation, not something
 * tuned against the outcomes it is about to be scored on. Re-tuning them on the same
 * ledger and then publishing the result would be in-sample fitting presented as skill.
 *
 * **The score.** A cell's 0-100 score is its **percentile** on this board, not a
 * probability. Nothing is hidden by that: `probability` (per-draw chance, in percent)
 * and `lift` (chance ÷ the 1% uniform rate) travel beside it, and `HEATMAP_HIGH_SCORE`
 * matches the green band in `constants/theme.ts`. Percentiles keep the grid legible —
 * a true probability grid is 0.3%–3% and every cell would look identical — while the
 * copy under the grid says exactly what the number means.
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
 * The ensemble allocation. Sums to 1, and the UI prints these as percentages.
 *
 * The order is the order the copy lists them in, and it is also the order the
 * per-model top picks are resolved in.
 */
export const HEATMAP_WEIGHTS = {
  markov: 0.25,
  frequency: 0.25,
  momentum: 0.25,
  montecarlo: 0.25,
} as const;

export type HeatmapModel = keyof typeof HEATMAP_WEIGHTS;

/**
 * The score at which a cell is green, matching `probabilityTone` in
 * `constants/theme.ts`. Kept as a constant so the walk-forward hit test and the grid's
 * colour cannot disagree about what "HIGH" means.
 */
export const HEATMAP_HIGH_SCORE = 75;

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
  /** Every code at or above `HEATMAP_HIGH_SCORE`. */
  high: string[];
  markov: string;
  frequency: string;
  momentum: string;
  montecarlo: string;
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

  const frequency = frequencyModel(sequence);
  const markov = markovModel(sequence, frequency);
  const momentum = momentumModel(sequence, frequency);
  const montecarlo = monteCarloModel(
    sequence,
    hashString(`${usable[0].date}|${usable[0].code}|${usable.length}`),
    simulations
  );

  const blended: Record<string, number> = {};
  for (const code of HEATMAP_CODES) {
    blended[code] =
      HEATMAP_WEIGHTS.markov * markov[code] +
      HEATMAP_WEIGHTS.frequency * frequency[code] +
      HEATMAP_WEIGHTS.momentum * momentum[code] +
      HEATMAP_WEIGHTS.montecarlo * montecarlo[code];
  }

  const score = percentiles(blended);
  const ranked = [...HEATMAP_CODES].sort((a, b) => blended[b] - blended[a] || (a < b ? -1 : 1));

  const cells: HeatmapCell[] = HEATMAP_CODES.map((code) => ({
    code,
    score: Math.round(score[code] * 10) / 10,
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
      high: ranked.filter((code) => score[code] >= HEATMAP_HIGH_SCORE),
      markov: argmax(markov),
      frequency: argmax(frequency),
      momentum: argmax(momentum),
      montecarlo: argmax(montecarlo),
    },
    sample: {
      draws: sequence.length,
      from: usable[usable.length - 1].date,
      to: usable[0].date,
      last: sequence[sequence.length - 1],
    },
    simulations,
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
  if (cell.score >= HEATMAP_HIGH_SCORE) {
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
