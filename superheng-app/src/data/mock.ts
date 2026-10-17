/**
 * Mock analytics layer.
 *
 * Everything here is deterministic placeholder data, shaped like the payloads
 * the planned FastAPI backend will eventually return (ARIMA / Markov /
 * Monte Carlo / LSTM ensembles). Swap these exports for API calls later without
 * touching the UI.
 */

import { DRAW_SCHEDULE } from '@/lib/draw';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type Confidence = 'High' | 'Medium' | 'Low';

/**
 * The four models the product advertises, in the order a payload lists them.
 *
 * Mirrors `MODEL_KEYS` in `backend/services.py`. A model is **never absent** from
 * a response: it is either `active` (it contributed a measured value to the
 * score being shown) or `neutral` (it was skipped), with the reason attached.
 * That is what lets the UI say "this model looked and found nothing" instead of
 * quietly dropping it.
 */
export const MODEL_KEYS = ['frequency', 'markov', 'timeseries', 'montecarlo'] as const;

export type ModelKey = (typeof MODEL_KEYS)[number];

/** Full display names, keyed like the backend's `MODEL_LABELS`. */
export const MODEL_LABELS: Record<ModelKey, string> = {
  frequency: 'Frequency',
  markov: 'Markov',
  timeseries: 'ARIMA',
  montecarlo: 'Monte Carlo',
};

/** Chip-face abbreviations, so four badges fit on one line on a phone. */
export const MODEL_SHORT_LABELS: Record<ModelKey, string> = {
  frequency: 'Freq',
  markov: 'Markov',
  timeseries: 'ARIMA',
  montecarlo: 'MC',
};

export type ModelStatusValue = 'active' | 'neutral';

/** One model's state for one pick, or for one channel's blend. */
export type ModelStatus = {
  /** Which model — derived from the payload key, so it can never be mislabelled. */
  key: ModelKey;
  label: string;
  status: ModelStatusValue;
  /** The weight actually applied. 0 for a neutral model. */
  weight: number;
  /**
   * Machine-readable reason: `applied`, `weighted_zero`,
   * `insufficient_support`, `not_in_blend`, `no_observed_transition`,
   * `no_arima_fit`, `not_reported`.
   */
  reason: string;
  /** The measured explanation, safe to show verbatim. */
  detail: string;
};

export type RankEntry = {
  /** 2-digit code, e.g. "48". */
  code: string;
  /** Model probability, 0-100. */
  probability: number;
  /** SuperHeng composite score, 0-100. */
  score: number;
  /** Change vs. the previous model run. */
  delta: number;
  /** Draws since last appearance, `null` when outside the sample window. */
  lastSeenDays: number | null;
  /**
   * One-line explanation of what drove the score, assembled by the backend from
   * the evidence it actually computed. Optional because the mock layer predates
   * it; the live `/api/predict/basic` payload always supplies one.
   */
  reason?: string;
  /**
   * All four models with their status for *this* code. Optional for the same
   * reason as `reason`: the mock fixtures predate it, so an entry without one
   * renders no chips rather than inventing them.
   */
  modelStatuses?: ModelStatus[];
};

export type TopPick = {
  code: string;
  score: number;
  verdict: string;
  confidence: Confidence;
  sampleSize: number;
  models: string[];
  /** Radar axes, each 0-1. */
  radar: number[];
};

export type TrendPoint = {
  /** Draw index (1 = most recent, 10 = oldest). */
  draw: number;
  /** Percentage of odd digits in that draw. */
  odd: number;
  /** Percentage of high digits (5-9) in that draw. */
  high: number;
};

/**
 * One entry of the Insights log.
 *
 * The copy is **not** here: it lives in `lib/i18n/{en,th}.ts` under
 * `insights.log.logN.*`, keyed by `id`, so the panel is translatable and the two
 * languages cannot drift. This type therefore carries only what the layout needs.
 */
export type AiLogEntry = {
  id: string;
  tag: 'Seasonal' | 'Markov' | 'Monte Carlo' | 'LSTM' | 'ARIMA';
  confidence: Confidence;
};

export type NumberAnalysis = {
  code: string;
  score: number;
  verdict: string;
  confidence: Confidence;
  appearances: number;
  lastWon: { date: string; prize: string; position: string } | null;
  parity: string;
  digitSum: number;
  advice: { title: string; body: string; tone: SignalTone }[];
  radar: number[];
};

export type SignalTone = 'high' | 'medium' | 'low' | 'cold';

// ---------------------------------------------------------------------------
// Radar / model vocabulary
// ---------------------------------------------------------------------------

export const RADAR_AXES = ['Frequency', 'Recency', 'Seasonality', 'Balance', 'Momentum'] as const;

export const MODEL_SIGNALS = [
  { key: 'arima', label: 'ARIMA', detail: 'Time-series drift', active: true },
  { key: 'markov', label: 'Markov Chain', detail: 'Transition matrix', active: true },
  { key: 'monte', label: 'Monte Carlo', detail: '10k simulations', active: true },
  { key: 'lstm', label: 'LSTM', detail: 'Sequence net', active: false },
] as const;

export const DRAW_META = {
  title: DRAW_SCHEDULE.title,
  timezone: DRAW_SCHEDULE.timezone,
  jackpot: '฿ 6,000,000',
  drawsAnalysed: 1284,
  uptime: '99.4%',
} as const;

// ---------------------------------------------------------------------------
// Hero "Top Pick"
// ---------------------------------------------------------------------------

export const TOP_PICK: TopPick = {
  code: '48',
  score: 92,
  verdict: 'Strong signal',
  confidence: 'High',
  sampleSize: 1240,
  models: ['ARIMA', 'Markov Chain', 'Monte Carlo'],
  //              Freq  Recency Seasonality Balance Momentum
  radar: [0.86, 0.94, 0.72, 0.81, 0.9],
};

// ---------------------------------------------------------------------------
// Rankings (2-digit "Top" vs "Bottom" positions)
// ---------------------------------------------------------------------------

export const RANKINGS: Record<'top' | 'bottom', RankEntry[]> = {
  top: [
    { code: '48', probability: 18.4, score: 92, delta: 2.4, lastSeenDays: 6 },
    { code: '17', probability: 16.1, score: 88, delta: 1.1, lastSeenDays: 12 },
    { code: '93', probability: 14.7, score: 84, delta: -0.6, lastSeenDays: 3 },
    { code: '26', probability: 12.9, score: 79, delta: 3.2, lastSeenDays: 21 },
    { code: '05', probability: 11.3, score: 74, delta: 0.4, lastSeenDays: 9 },
  ],
  bottom: [
    { code: '72', probability: 17.8, score: 90, delta: 1.8, lastSeenDays: 4 },
    { code: '39', probability: 15.2, score: 86, delta: 2.9, lastSeenDays: 15 },
    { code: '64', probability: 13.5, score: 81, delta: -1.4, lastSeenDays: 2 },
    { code: '81', probability: 11.9, score: 76, delta: 0.8, lastSeenDays: 18 },
    { code: '20', probability: 10.6, score: 71, delta: -0.3, lastSeenDays: 11 },
  ],
};

// ---------------------------------------------------------------------------
// "My Number" demo figure — not the heatmap
// ---------------------------------------------------------------------------

/** Deterministic 32-bit hash -> 0..1, so mock data never reshuffles on reload. */
function hash01(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * A deterministic 0-100 figure for the demo analyzer's copy.
 *
 * This is **not** the heatmap. The Insights grid is a real ensemble over the published
 * ledger (`lib/heatmap.ts`); this number only fills a sentence on the "My Number" demo,
 * which is hand-written sample analysis rather than a model output. It is private so no
 * screen can mistake it for the grid.
 */
function sampleHeatScore(code: string): number {
  const index = Number(code.slice(-2));
  if (!Number.isFinite(index)) return 0;
  const override = [...RANKINGS.top, ...RANKINGS.bottom].find((entry) => entry.code === code);
  if (override) return Math.min(100, Math.round((override.probability * 4 + 8) * 10) / 10);
  return Math.round((4 + hash01(index * 7919 + 13) * 62 + (index % 10) * 1.4) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Trend series (last 10 draws)
// ---------------------------------------------------------------------------

export const TREND_SERIES: TrendPoint[] = [
  { draw: 1, odd: 40, high: 50 },
  { draw: 2, odd: 60, high: 40 },
  { draw: 3, odd: 50, high: 60 },
  { draw: 4, odd: 70, high: 55 },
  { draw: 5, odd: 45, high: 65 },
  { draw: 6, odd: 55, high: 45 },
  { draw: 7, odd: 65, high: 70 },
  { draw: 8, odd: 35, high: 40 },
  { draw: 9, odd: 60, high: 55 },
  { draw: 10, odd: 50, high: 60 },
];

// ---------------------------------------------------------------------------
// AI reasoning log
// ---------------------------------------------------------------------------

export const AI_LOG: AiLogEntry[] = [
  { id: 'log-1', tag: 'Seasonal', confidence: 'High' },
  { id: 'log-2', tag: 'Markov', confidence: 'Medium' },
  { id: 'log-3', tag: 'Monte Carlo', confidence: 'Medium' },
  { id: 'log-4', tag: 'ARIMA', confidence: 'Low' },
];

// ---------------------------------------------------------------------------
// "My Number" analysis
// ---------------------------------------------------------------------------

/** Deterministic mock analysis for any 2-3 digit input. */
export function analyzeNumber(input: string): NumberAnalysis {
  const code = input.replace(/\D/g, '').padStart(2, '0').slice(0, 3);
  const seed = [...code].reduce((acc, char) => acc * 31 + char.charCodeAt(0), 7);
  const score = 52 + Math.round(hash01(seed) * 45);
  const probability = sampleHeatScore(code.slice(-2));
  const appearances = 3 + Math.round(hash01(seed + 91) * 22);
  const wonRecently = hash01(seed + 5) > 0.5;

  const confidence: Confidence = score >= 80 ? 'High' : score >= 65 ? 'Medium' : 'Low';
  const verdict =
    score >= 80
      ? 'Favourable statistical position'
      : score >= 65
        ? 'Mild positive signal'
        : 'Neutral — no strong edge';

  const digitSum = [...code].reduce((acc, char) => acc + Number(char), 0);
  const oddCount = [...code].filter((char) => Number(char) % 2 === 1).length;

  return {
    code,
    score,
    verdict,
    confidence,
    appearances,
    lastWon: wonRecently
      ? {
          // Real GLO draw dates are the 1st and the 16th, so the mock must not invent
          // a 19th. 16 Aug 2026 is a draw that is actually in the ledger.
          date: '2026-08-16',
          prize: 'เลขท้าย 2 ตัว',
          position: 'Top position',
        }
      : null,
    parity: oddCount === 0 ? 'All even' : oddCount === code.length ? 'All odd' : 'Mixed parity',
    digitSum,
    advice: [
      {
        title: 'Model consensus',
        body: `Probability of ${probability.toFixed(1)}% for the trailing pair "${code.slice(-2)}", ranked against the current 00-99 grid.`,
        tone: score >= 75 ? 'high' : score >= 55 ? 'medium' : 'cold',
      },
      {
        title: 'Positioning',
        body:
          confidence === 'High'
            ? 'Signals are concentrated in the Top position. Focus exposure there rather than splitting evenly.'
            : 'Signals are spread across positions. Treat this as a diversification candidate, not a core pick.',
        tone: confidence === 'High' ? 'high' : confidence === 'Medium' ? 'medium' : 'cold',
      },
      {
        title: 'Risk note',
        body: `Digit sum ${digitSum} with ${oddCount} odd digit${oddCount === 1 ? '' : 's'}. This configuration appeared in ${appearances} of the last 1,284 draws.`,
        tone: 'low',
      },
    ],
    //             Freq  Recency Seasonality Balance Momentum
    radar: [
      hash01(seed + 1) * 0.6 + 0.3,
      hash01(seed + 2) * 0.7 + 0.2,
      hash01(seed + 3) * 0.8 + 0.1,
      hash01(seed + 4) * 0.6 + 0.3,
      hash01(seed + 6) * 0.7 + 0.25,
    ].map((value) => Math.min(1, Math.max(0, value))),
  };
}

