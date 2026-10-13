/**
 * SuperHeng API client.
 *
 * One module owns every network call, so screens never assemble URLs or walk a
 * raw payload. The types below mirror `backend/services.py::analyse_draws()`
 * field for field — if the API changes shape, this is the one file to update.
 *
 * **Where the picks live:** at `channels.<top|bottom>.rankings`, *not* at a
 * top-level `rankings` key. Frequency and Markov evidence sit alongside them per
 * channel, because the two 2-digit positions are different variables (GLO draws
 * the last-two prize independently of the first prize) and the backend never
 * pools them.
 */

import type { RankEntry, SignalTone } from '@/data/mock';

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

/**
 * Where the FastAPI backend is listening.
 *
 * `127.0.0.1` means *the device running the app*, so the right host depends on
 * where you are testing:
 *
 * | Target                 | BASE_URL                    |
 * | ---------------------- | --------------------------- |
 * | Web browser            | `http://127.0.0.1:8000`     |
 * | iOS simulator          | `http://127.0.0.1:8000`     |
 * | Android **emulator**   | `http://10.0.2.2:8000`      |
 * | Physical phone (Wi-Fi) | `http://192.168.1.xxx:8000` |
 *
 * On a physical Android or iOS device, use your computer's LAN address
 * (`ipconfig` on Windows, `ifconfig` / `ip addr` on macOS and Linux), keep the
 * phone on the same Wi-Fi, and bind the server to every interface rather than
 * loopback — `uvicorn main:app --host 0.0.0.0 --port 8000`. With the default
 * `--host 127.0.0.1` the request is refused before it leaves the computer.
 *
 * Prefer setting `EXPO_PUBLIC_API_URL` in `.env` over editing this line: Expo
 * inlines every `EXPO_PUBLIC_*` value at bundle time, so the default below stays
 * correct for the simulator and web without a source change.
 */
export const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';

/** How long to wait before treating a request as unreachable. */
export const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Response types (mirror of backend/services.py)
// ---------------------------------------------------------------------------

export type PredictionStatus = 'ok' | 'limited' | 'insufficient_data';

/** The two independently drawn 2-digit positions. */
export type ChannelKey = 'top' | 'bottom';

/** One code's unconditional rate in a channel. */
export type FrequencyEvidence = {
  code: string;
  count: number;
  /** `count / draws`, 0-1. */
  share: number;
  /** `draws / 100` — the uniform baseline. */
  expected: number;
  /** `count / expected`; 1.0 means exactly uniform. */
  lift: number;
};

/** One candidate's conditional probability after the current state. */
export type MarkovEvidence = {
  code: string;
  /** Raw transitions observed into this code. */
  count: number;
  /** Smoothed `P(next = code | current)`. */
  conditional: number;
  /** Smoothed `P(code)` overall. */
  unconditional: number;
  lift: number;
};

/** A single ranked candidate, as emitted inside `channels[x].rankings`. */
export type ApiRanking = {
  code: string;
  /** Blended per-draw probability 0-100. Uniform across 100 codes is 1.0. */
  probability: number;
  /** Heng Score, 0-100. */
  score: number;
  /** Change vs. the previous model run — 0.0 until runs are persisted. */
  delta: number;
  lastSeenDays: number | null;
  tone: SignalTone;
  reason: string;
  evidence: {
    frequency: FrequencyEvidence;
    /** `null` when the Markov row is unusable for this channel. */
    markov: MarkovEvidence | null;
  };
};

export type MarkovSummary = {
  channel: ChannelKey;
  /** The most recent draw's code in this channel. */
  current_state: string;
  /** Observed transitions out of the current state — what the estimate rests on. */
  support: number;
  /** False when `support` is below the backend's floor. */
  usable: boolean;
  top_transitions: MarkovEvidence[];
};

export type ChannelPayload = {
  channel: ChannelKey;
  label: string;
  draws: number;
  current_state: string;
  /** The weights actually applied, renormalised over the available signals. */
  weights: Record<string, number>;
  frequencies: FrequencyEvidence[];
  markov: MarkovSummary;
  rankings: ApiRanking[];
};

export type BasicPredictions = {
  status: PredictionStatus;
  draws_analyzed: number;
  date_range: { from: string | null; to: string | null };
  latest_draw: { draw_date: string; first_prize: string; bottom_two: string } | null;
  weights_configured: Record<string, number>;
  smoothing: number;
  tone_thresholds: Record<SignalTone, number>;
  channels: Record<ChannelKey, ChannelPayload>;
  /** Every limitation the backend wants visible. Rendered, never discarded. */
  warnings: string[];
  methodology: string;
  /**
   * ISO date of the *next* draw, when the backend knows it.
   *
   * Day 3's payload does not carry one — it reports `latest_draw.draw_date` and
   * `date_range` — so this is normally absent and the dashboard falls back to the
   * locally computed GLO schedule. It is typed anyway so that adding the field
   * server-side lights the banner up with no client change.
   */
  next_draw_date?: string | null;
};

// ---------------------------------------------------------------------------
// Premium — Bayesian positional insights (`/api/predict/premium`)
// ---------------------------------------------------------------------------

/** Response key for each of the four modelled positions of the 6-digit first prize. */
export type PositionKey = 'thousands' | 'hundreds' | 'tens' | 'units';

/**
 * Display order for the four positions.
 *
 * The backend returns them as an object, and nothing guarantees a browser or
 * Hermes preserves key insertion order, so the UI iterates this list rather than
 * `Object.keys(positions)`.
 */
export const POSITION_KEYS: readonly PositionKey[] = ['thousands', 'hundreds', 'tens', 'units'];

/** Which posterior a position ranked on. */
export type PositionBasis = 'conditional' | 'marginal';

/** One candidate digit at one position, as emitted inside `positions[x].top`. */
export type PositionalDigit = {
  /** A single digit, "0"-"9". */
  digit: string;
  /** Posterior probability 0.0-1.0 — the value the ranking is based on. */
  probability: number;
  /** `P(digit | position)`, 0.0-1.0 — the un-conditional baseline to compare against. */
  marginal: number;
  /** `probability / marginal`; 1.0 means the digit tracks its overall rate. */
  lift: number;
  /** Raw draws supporting this pick (a joint count when `basis` is conditional). */
  count: number;
  /** Raw draws available for the conditioning state. */
  support: number;
  basis: PositionBasis;
  /** Math-derived explanation assembled from the counts above. */
  reason: string;
};

/** One position's full posterior plus its top picks. */
export type PositionalEstimate = {
  name: PositionKey;
  /** Human label, e.g. "Hundreds (หลักร้อย)". */
  label: string;
  /** Index into the 6-digit prize string (2-5). */
  index: number;
  /** The adjacent higher position this one is conditioned on. */
  conditioned_on: string;
  /** The latest draw's digit at `conditioned_on`, or null without history. */
  conditioned_digit: string | null;
  support: number;
  /** False when the conditional row was too thin and the marginal was used. */
  usable: boolean;
  basis: PositionBasis;
  /** The posterior the ranking used — all ten digits, keyed "0".."9". */
  distribution: Record<string, number>;
  marginal_distribution: Record<string, number>;
  top: PositionalDigit[];
};

export type PremiumInsights = {
  status: PredictionStatus;
  model: 'bayesian_positional';
  draws_analyzed: number;
  date_range: { from: string | null; to: string | null };
  latest_draw: { draw_date: string; first_prize: string } | null;
  /**
   * Empty when the ledger is too thin to rank anything. That is a successful
   * `insufficient_data` response, not an error — render an empty state.
   */
  positions: Partial<Record<PositionKey, PositionalEstimate>>;
  warnings: string[];
  methodology: string;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'malformed';

/** A failed call, classified so the UI can say something actionable. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

/** Narrows an unknown rejection to an `ApiError`. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function toStatus(value: unknown): PredictionStatus {
  return value === 'ok' || value === 'limited' ? value : 'insufficient_data';
}

function asBasis(value: unknown): PositionBasis {
  return value === 'marginal' ? 'marginal' : 'conditional';
}

function asSignalTone(value: unknown): SignalTone {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'cold'
    ? value
    : 'cold';
}

function toFrequencyEvidence(raw: unknown): FrequencyEvidence {
  const row = asRecord(raw) ?? {};
  return {
    code: asString(row.code),
    count: asNumber(row.count),
    share: asNumber(row.share),
    expected: asNumber(row.expected),
    lift: asNumber(row.lift),
  };
}

function toMarkovEvidence(raw: unknown): MarkovEvidence | null {
  const row = asRecord(raw);
  if (!row) return null;
  return {
    code: asString(row.code),
    count: asNumber(row.count),
    conditional: asNumber(row.conditional),
    unconditional: asNumber(row.unconditional),
    lift: asNumber(row.lift),
  };
}

function toApiRanking(raw: unknown): ApiRanking | null {
  const row = asRecord(raw);
  if (!row || typeof row.code !== 'string') return null;
  const evidence = asRecord(row.evidence) ?? {};
  return {
    code: row.code,
    probability: asNumber(row.probability),
    score: asNumber(row.score),
    delta: asNumber(row.delta),
    lastSeenDays: row.lastSeenDays === null ? null : asNumber(row.lastSeenDays),
    tone: asSignalTone(row.tone),
    reason: asString(row.reason),
    evidence: {
      frequency: toFrequencyEvidence(evidence.frequency),
      markov: toMarkovEvidence(evidence.markov),
    },
  };
}

function toChannel(raw: unknown): ChannelPayload | null {
  const channel = asRecord(raw);
  if (!channel || !Array.isArray(channel.rankings)) return null;

  const markov = asRecord(channel.markov) ?? {};
  const weights = asRecord(channel.weights) ?? {};

  return {
    channel: channel.channel === 'bottom' ? 'bottom' : 'top',
    label: asString(channel.label),
    draws: asNumber(channel.draws),
    current_state: asString(channel.current_state),
    weights: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, asNumber(v)])),
    frequencies: (Array.isArray(channel.frequencies) ? channel.frequencies : []).map(
      toFrequencyEvidence
    ),
    markov: {
      channel: markov.channel === 'bottom' ? 'bottom' : 'top',
      current_state: asString(markov.current_state),
      support: asNumber(markov.support),
      usable: markov.usable === true,
      top_transitions: (Array.isArray(markov.top_transitions) ? markov.top_transitions : [])
        .map(toMarkovEvidence)
        .filter((row): row is MarkovEvidence => row !== null),
    },
    rankings: channel.rankings
      .map(toApiRanking)
      .filter((row): row is ApiRanking => row !== null),
  };
}

/**
 * Validates and normalises a raw payload.
 *
 * Deliberately tolerant of *additive* server changes and strict about the two
 * things the dashboard cannot render without: both channels, each with a
 * `rankings` array. Anything else would surface later as a crash mid-render,
 * which is far worse than one clear "unexpected payload" error.
 */
export function parsePredictions(body: unknown): BasicPredictions {
  const root = asRecord(body);
  if (!root) throw new ApiError('malformed', 'The prediction service returned a non-object body.');

  const channels = asRecord(root.channels);
  const top = toChannel(channels?.top);
  const bottom = toChannel(channels?.bottom);
  if (!top || !bottom) {
    throw new ApiError(
      'malformed',
      'The prediction service response is missing channels.top / channels.bottom.'
    );
  }

  const range = asRecord(root.date_range) ?? {};
  const latest = asRecord(root.latest_draw);

  return {
    status: toStatus(root.status),
    draws_analyzed: asNumber(root.draws_analyzed),
    date_range: {
      from: typeof range.from === 'string' ? range.from : null,
      to: typeof range.to === 'string' ? range.to : null,
    },
    latest_draw: latest
      ? {
          draw_date: asString(latest.draw_date),
          first_prize: asString(latest.first_prize),
          bottom_two: asString(latest.bottom_two),
        }
      : null,
    weights_configured: Object.fromEntries(
      Object.entries(asRecord(root.weights_configured) ?? {}).map(([k, v]) => [k, asNumber(v)])
    ),
    smoothing: asNumber(root.smoothing),
    tone_thresholds: {
      high: asNumber(asRecord(root.tone_thresholds)?.high, 75),
      medium: asNumber(asRecord(root.tone_thresholds)?.medium, 55),
      low: asNumber(asRecord(root.tone_thresholds)?.low, 35),
      cold: asNumber(asRecord(root.tone_thresholds)?.cold, 0),
    },
    channels: { top, bottom },
    warnings: (Array.isArray(root.warnings) ? root.warnings : []).filter(
      (item): item is string => typeof item === 'string'
    ),
    methodology: asString(root.methodology),
    next_draw_date: typeof root.next_draw_date === 'string' ? root.next_draw_date : null,
  };
}

function toNumberRecord(raw: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(asRecord(raw) ?? {}).map(([key, value]) => [key, asNumber(value)])
  );
}

function toPositionalDigit(raw: unknown): PositionalDigit | null {
  const row = asRecord(raw);
  if (!row || typeof row.digit !== 'string') return null;
  return {
    digit: row.digit,
    probability: asNumber(row.probability),
    marginal: asNumber(row.marginal),
    lift: asNumber(row.lift),
    count: asNumber(row.count),
    support: asNumber(row.support),
    basis: asBasis(row.basis),
    reason: asString(row.reason),
  };
}

function toPositionalEstimate(name: PositionKey, raw: unknown): PositionalEstimate | null {
  const row = asRecord(raw);
  if (!row) return null;
  return {
    name,
    label: asString(row.label, name),
    index: asNumber(row.index),
    conditioned_on: asString(row.conditioned_on),
    conditioned_digit:
      typeof row.conditioned_digit === 'string' ? row.conditioned_digit : null,
    support: asNumber(row.support),
    usable: row.usable === true,
    basis: asBasis(row.basis),
    distribution: toNumberRecord(row.distribution),
    marginal_distribution: toNumberRecord(row.marginal_distribution),
    top: (Array.isArray(row.top) ? row.top : [])
      .map(toPositionalDigit)
      .filter((entry): entry is PositionalDigit => entry !== null),
  };
}

/**
 * Validates and normalises the `/api/predict/premium` payload.
 *
 * Unlike `parsePredictions` this does **not** require any position to be
 * present: an empty ledger legitimately answers `insufficient_data` with
 * `positions: {}`, and that has to render as an empty state rather than as a
 * parse failure. Anything the parser cannot read is omitted rather than
 * invented.
 */
export function parsePremiumInsights(body: unknown): PremiumInsights {
  const root = asRecord(body);
  if (!root) {
    throw new ApiError('malformed', 'The premium service returned a non-object body.');
  }

  const rawPositions = asRecord(root.positions) ?? {};
  const positions: Partial<Record<PositionKey, PositionalEstimate>> = {};
  for (const key of POSITION_KEYS) {
    const estimate = toPositionalEstimate(key, rawPositions[key]);
    if (estimate) positions[key] = estimate;
  }

  const range = asRecord(root.date_range) ?? {};
  const latest = asRecord(root.latest_draw);

  return {
    status: toStatus(root.status),
    model: 'bayesian_positional',
    draws_analyzed: asNumber(root.draws_analyzed),
    date_range: {
      from: typeof range.from === 'string' ? range.from : null,
      to: typeof range.to === 'string' ? range.to : null,
    },
    latest_draw: latest
      ? {
          draw_date: asString(latest.draw_date),
          first_prize: asString(latest.first_prize),
        }
      : null,
    positions,
    warnings: (Array.isArray(root.warnings) ? root.warnings : []).filter(
      (item): item is string => typeof item === 'string'
    ),
    methodology: asString(root.methodology),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function request(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(
          'timeout',
          `The prediction service at ${BASE_URL} did not answer within ` +
            `${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`
        );
      }
      throw error;
    }

    let text = '';
    try {
      text = await response.text();
    } catch {
      throw new ApiError(
        'network',
        `The connection to ${BASE_URL} dropped while reading the response.`
      );
    }

    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!response.ok) {
      // FastAPI reports handled failures as `{"detail": "..."}`. Read it when it
      // is a string so a 503 "Supabase is not configured" reaches the user as
      // that sentence rather than a bare status code.
      const detail = asRecord(body)?.detail;
      throw new ApiError(
        'http',
        typeof detail === 'string' && detail
          ? detail
          : `The prediction service returned HTTP ${response.status}.`,
        response.status
      );
    }

    if (body === null) {
      throw new ApiError('malformed', 'The prediction service returned an empty response.');
    }

    return body;
  } catch (error) {
    if (isApiError(error)) throw error;
    throw new ApiError(
      'network',
      `Cannot reach the prediction service at ${BASE_URL}. Check that the ` +
        'backend is running and that this device can see it.'
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Frequency + Markov picks for both 2-digit positions.
 *
 * Resolves for degraded payloads too: an empty or thin ledger is a successful
 * request that comes back with `status: 'insufficient_data'` and `warnings`
 * populated, so the caller renders an empty state rather than an error. A
 * rejection always means the call itself failed — see `ApiError.kind`.
 *
 * @param limit How many recent draws to analyse. Omit for the whole ledger.
 */
export async function getBasicPredictions(limit?: number): Promise<BasicPredictions> {
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
  return parsePredictions(await request(`/api/predict/basic${query}`));
}

/**
 * Bayesian positional posteriors for the four lower digits of รางวัลที่ 1 — the
 * Premium tier.
 *
 * Degrades exactly like `getBasicPredictions`: a thin or empty ledger resolves
 * with `status: 'limited'` / `'insufficient_data'`, `positions` empty or partial,
 * and `warnings` populated, so the caller renders an empty state instead of an
 * error. A rejection always means the call itself failed — see `ApiError.kind`.
 *
 * @param limit How many recent draws to analyse. Omit for the whole ledger.
 */
export async function getPremiumInsights(limit?: number): Promise<PremiumInsights> {
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
  return parsePremiumInsights(await request(`/api/predict/premium${query}`));
}

// ---------------------------------------------------------------------------
// UI mapping
// ---------------------------------------------------------------------------

/** Projects one API ranking onto the `RankEntry` the ranking list renders. */
export function toRankEntry(ranking: ApiRanking): RankEntry {
  return {
    code: ranking.code,
    probability: ranking.probability,
    score: ranking.score,
    delta: ranking.delta,
    lastSeenDays: ranking.lastSeenDays,
    reason: ranking.reason,
  };
}

/** Both markets, ready for `RANKINGS[market]`-style lookup. */
export function toRankings(predictions: BasicPredictions): Record<ChannelKey, RankEntry[]> {
  return {
    top: predictions.channels.top.rankings.map(toRankEntry),
    bottom: predictions.channels.bottom.rankings.map(toRankEntry),
  };
}
