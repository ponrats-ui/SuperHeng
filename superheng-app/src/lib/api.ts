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

import { MODEL_KEYS, MODEL_LABELS, type ModelKey, type ModelStatus, type RankEntry, type SignalTone } from '@/data/mock';

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

/**
 * How long one *attempt* waits before it is treated as unreachable.
 *
 * This is not the request budget — see `WAKE_DEADLINE_MS`. A hung attempt is
 * the signature of a sleeping instance (see `request` below), not proof that the
 * service is down, so the transport retries until that deadline instead of
 * giving up here.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long the transport keeps retrying before it reports failure.
 *
 * Sized for a cold start, not for a healthy server: Render's free instances spin
 * down after inactivity and the dashboard warns that waking one "can delay
 * requests by 50 seconds or more". A single 10s attempt can never cover that, so
 * the budget is deliberately minutes-shaped rather than seconds-shaped while the
 * per-attempt timeout stays short enough to notice a genuinely dead service.
 */
export const WAKE_DEADLINE_MS = 75_000;

/**
 * Pause before each retry, in order. The last value repeats once exhausted.
 *
 * Rising rather than fixed: the first retry happens while the instance is still
 * booting, so hammering it gains nothing, and by the fifth the server is usually
 * seconds from answering.
 */
export const RETRY_BACKOFF_MS = [1_000, 2_000, 3_000, 5_000, 8_000] as const;

/**
 * How long the transport keeps retrying a network failure before it reports one.
 *
 * A minute, matching the sleep/wake cycle it exists to cover, and deliberately
 * shorter than `WAKE_DEADLINE_MS`: see `NETWORK_RETRY_INTERVAL_MS` for why this
 * failure shape gets its own budget rather than sharing the hung-attempt one.
 */
export const NETWORK_DEADLINE_MS = 60_000;

/**
 * Fixed pause between retries of a network failure, as opposed to the rising
 * backoff used for a hung attempt.
 *
 * The two failure shapes need different treatment. A hung attempt is the proxy
 * parking the connection while an instance boots, and it resolves on its own
 * timeline, so a rising backoff wastes nothing. A *network* failure is what a
 * browser reports when the response never arrives *at all* — a 502 from Render's
 * proxy carries no `Access-Control-Allow-Origin` header, so the browser blocks it
 * and `fetch` rejects with a bare `TypeError`, indistinguishable from a refused
 * connection. There is no status to read and no progress to observe, so the only
 * thing to do is ask again at an interval that neither hammers the service nor
 * leaves the reader staring at a stopped screen: five seconds.
 */
export const NETWORK_RETRY_INTERVAL_MS = 5_000;

/**
 * Hosts where a network failure means "nothing is listening", not "the hosted
 * service is cold".
 *
 * This is the discriminator that makes retrying network failures safe. In a
 * browser the two cases are the same `TypeError`, but they are not the same
 * situation: against a deployed API a refusal almost always means a proxy 502
 * during a cold start and is worth waiting out, while against `127.0.0.1` — local
 * development with `uvicorn` not yet started — it means the developer has no
 * backend, and retrying for a minute would hide that behind a spinner.
 *
 * `10.0.2.2` is the Android emulator's alias for the developer's own machine, so
 * it belongs in this list for the same reason as the loopback addresses.
 */
const NO_RETRY_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1', '10.0.2.2'];

/** Whether `BASE_URL` points at the machine running the app rather than at a host. */
function isLocalTarget(): boolean {
  try {
    // `URL` needs a scheme; BASE_URL always has one, but a malformed value here
    // must not throw inside the retry decision.
    const { hostname } = new URL(BASE_URL);
    return NO_RETRY_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Per-attempt budget for `/api/backtest`, which is the one endpoint that
 * legitimately computes for seconds rather than milliseconds.
 *
 * A walk-forward replay re-runs the models once per replayed draw. Measured on a
 * 400-draw ledger: about 3 s for 30 draws and 5 s for 60. That is well past the
 * 10 s default only once a cold Render instance is added on top, so this budget
 * is sized for compute plus a cold start rather than for the compute alone — the
 * alternative is `request` classifying a working-but-slow answer as `timeout`
 * and paying for the same replay a second time.
 */
export const BACKTEST_TIMEOUT_MS = 30_000;

/**
 * Told to the caller before each retry, so the UI can name what it is waiting for.
 */
export type RequestProgress = {
  /** The attempt that is about to start — 2 on the first retry. */
  attempt: number;
  /** Milliseconds since the first attempt began. */
  elapsedMs: number;
  /** Why the previous attempt ended. */
  lastKind: ApiErrorKind;
};

export type RequestOptions = {
  /**
   * Called before each retry.
   *
   * The dashboard uses it to switch its spinner from "loading" to "waking the
   * server", which is the difference between a pause a user waits out and one
   * they read as a dead backend.
   */
  onRetry?: (progress: RequestProgress) => void;
  /**
   * Overrides for unusually slow endpoints and for tests. The defaults are the
   * production budgets, and both are per request.
   *
   * `attemptTimeoutMs` is the one to raise for an endpoint that legitimately
   * computes for longer than `REQUEST_TIMEOUT_MS` — otherwise the transport reads
   * slow-but-working as `timeout` and retries it, spending the server's time
   * twice for one answer.
   */
  attemptTimeoutMs?: number;
  deadlineMs?: number;
  /**
   * Supabase access token for the gated endpoints.
   *
   * Sent as `Authorization: Bearer <token>` when present. It is a per-request
   * option rather than module state on purpose: the token changes when Supabase
   * refreshes the session, and a module-level copy would be the one value that is
   * stale exactly when a request is in flight.
   *
   * Omitting it on a gated endpoint is a 401 from the server, never a silent
   * anonymous call — the API does not fall back to a shared credential.
   */
  accessToken?: string;
  /** HTTP method. Defaults to GET; only the checkout stub posts anything. */
  method?: 'GET' | 'POST';
  /** JSON body for a POST. Serialised here so callers pass an object, not a string. */
  body?: unknown;
};

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

/**
 * A single ranked candidate, as emitted inside `channels[x].rankings`.
 *
 * `model_statuses` is the "transparency" field: every pick carries all four
 * models, each `active` or `neutral`, so a model the backend skipped is visible
 * as a labelled absence rather than missing from the payload. It is parsed
 * defensively for the same reason `reason` is — an older backend (or the dev
 * stub) simply omits it, and the UI then renders no chips instead of four
 * invented ones.
 */
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
  /** Empty when the response predates the field. Never synthesised. */
  modelStatuses: ModelStatus[];
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
  /** The same four models at channel level: what this blend did and skipped. */
  modelStatuses: ModelStatus[];
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

/**
 * The ledgers the backend holds, one per country.
 *
 * Mirrors `LotteryType` in `backend/main.py` and the `lottery_type` CHECK
 * constraint in `backend/schema.sql`: the three places move together, and a new
 * country has to be added to all three or the API answers 422.
 */
export type LotteryType = 'thai' | 'laos' | 'vietnam';

/** Display order of the country tabs, and the value sent as `?type=`. */
export const LOTTERY_TYPES: readonly LotteryType[] = ['thai', 'laos', 'vietnam'];

/**
 * One published draw, as `/api/latest-draws` returns it.
 *
 * `bottomTwo` is the separately drawn เลขท้าย 2 ตัว — the 2-digit prize a 00-99
 * heatmap is actually modelling. It is not derived from `firstPrize`: GLO draws the
 * two prizes independently, which is why the ensemble never reads the first prize's
 * trailing digits as if they were the same variable.
 */
export type LatestDrawRow = {
  date: string;
  firstPrize: string;
  bottomTwo: string;
  lotteryType: LotteryType;
};

/**
 * Response key for a modelled position of a first prize.
 *
 * Every key a lottery can publish is listed; which ones a response actually
 * carries depends on how many digits its first prize has. Thailand's รางวัลที่ 1
 * and Laos's first prize are six digits and use all six; Vietnam's giải đặc biệt
 * is five, so its response starts at `ten_thousands` and `hundred_thousands` is
 * simply absent — the prize has no digit there to estimate.
 */
export type PositionKey =
  | 'hundred_thousands'
  | 'ten_thousands'
  | 'thousands'
  | 'hundreds'
  | 'tens'
  | 'units';

/**
 * Display order for every position a ledger can have, left to right as the prize
 * is read. A lottery with a shorter prize publishes a subset, in this order.
 *
 * The backend returns them as an object, and nothing guarantees a browser or
 * Hermes preserves key insertion order, so the UI iterates this list rather than
 * `Object.keys(positions)`.
 */
export const POSITION_KEYS: readonly PositionKey[] = [
  'hundred_thousands',
  'ten_thousands',
  'thousands',
  'hundreds',
  'tens',
  'units',
];

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
  /** Index into the 6-digit prize string (0-5; 0 is the leading digit). */
  index: number;
  /**
   * The adjacent higher position this one is conditioned on, or null for the
   * leading digit, which has no higher neighbour.
   */
  conditioned_on: PositionKey | null;
  /** The latest draw's digit at `conditioned_on`, or null without history. */
  conditioned_digit: string | null;
  support: number;
  /**
   * False when the conditional row was too thin and the marginal was used. The
   * leading digit is always usable: it ranks on the marginal by design.
   */
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
  /**
   * The ledger these numbers came from — echoed by the endpoint so a response can
   * be matched against the tab that asked for it.
   */
  lottery_type: LotteryType;
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

/** One of the digits the positional model ranked for a position. */
export type AccuracyDigit = {
  digit: string;
  /** Posterior probability 0.0-1.0, or null when the server stated none. */
  probability: number | null;
};

/**
 * One position of one draw: the model's ranking beside the digit drawn.
 *
 * `hit`, `in_top` and `actual_rank` are taken from the server rather than
 * recomputed here. They are the same fact stated three ways, the backend pins that
 * relationship in its own tests, and deriving a second copy in the client is how the
 * two eventually disagree about whether a row is green.
 */
export type AccuracyPosition = {
  name: PositionKey;
  /** 0 is the leading digit of the first prize. */
  index: number;
  /** The digit that was actually drawn at this position. */
  actual: string;
  /** The model's top pick, or null when it ranked nothing for this position. */
  predicted: string | null;
  hit: boolean;
  /** The actual digit is somewhere in `top` — a near miss rather than a hit. */
  in_top: boolean;
  /** 1-based rank of the actual digit among `top`, or null when it is not there. */
  actual_rank: number | null;
  top: AccuracyDigit[];
  support: number;
  basis: PositionBasis;
};

/** One 2-digit channel, scored for one draw. */
export type AccuracyChannel = {
  available: boolean;
  actual: string | null;
  picks: string[];
  predicted: string | null;
  exact_hit: boolean;
  in_top_5: boolean;
  /** Why the channel could not be scored, when it could not be. */
  reason: string | null;
};

/** One completed draw, compared against what the model said about it. */
export type AccuracyComparison = {
  draw_date: string;
  first_prize: string;
  bottom_two: string;
  /** Last two digits of the first prize, or null when the prize is too short. */
  top_two: string | null;
  /** How many earlier draws the model was given. Worth showing: it is the sample. */
  train_size: number;
  positions: AccuracyPosition[];
  position_hits: number;
  /** Positions where the actual digit was in the model's top three. */
  position_in_top: number;
  position_predictions: number;
  channels: Partial<Record<ChannelKey, AccuracyChannel>>;
};

/**
 * A rate with the baseline it has to be judged against.
 *
 * One shape for every rate in the report, so no number can reach the screen without
 * the baseline that gives it meaning.
 */
export type AccuracyRate = {
  hits: number;
  predictions: number;
  hit_rate_percent: number | null;
  baseline_percent: number;
  lift_vs_uniform: number | null;
  p_value: number;
  significant: boolean;
  /** Hits out of `predictions` that would have cleared alpha. Null when unreachable. */
  hits_needed: number | null;
  alpha: number;
};

export type AccuracyPositional = {
  model: 'bayesian_positional';
  draws: number;
  prize_digits: number;
  positions: Partial<Record<PositionKey, AccuracyRate>>;
  overall: AccuracyRate;
};

export type AccuracyChannelReport = {
  available: boolean;
  draws: number;
  exact?: AccuracyRate;
  in_top_5?: AccuracyRate;
  picks_per_draw?: number;
  reason?: string;
};

/**
 * The `/api/premium/accuracy-report` payload.
 *
 * **A replay, not a record.** The service stores no prediction when it makes one, so
 * the server re-runs the model for each target draw using only the draws before it
 * and compares that with the result that was published. `replay_notice` says so in
 * the server's own words and is rendered as-is; presenting this as a forecast made
 * before the draw would be a claim about the past that nothing supports.
 */
export type AccuracyReport = {
  status: PredictionStatus;
  lottery_type: LotteryType;
  prize_digits: number;
  model: 'bayesian_positional';
  draws_requested: number;
  draws_evaluated: number;
  train_window: number;
  top_k: number;
  /**
   * How the comparison was produced — `walk_forward_replay` today. A string rather
   * than a literal so a future recorded-prediction mode can name itself instead of
   * having to be distinguished by absence.
   */
  prediction_basis: string;
  replay_notice: string;
  /** Newest first. The first entry is the headline the card shows. */
  comparisons: AccuracyComparison[];
  accuracy: {
    positional: AccuracyPositional;
    channels: Partial<Record<ChannelKey, AccuracyChannelReport>>;
  };
  date_range: { from: string | null; to: string | null };
  train_sizes: { min: number; max: number };
  warnings: string[];
  /** What this report cannot establish. Rendered, not folded away. */
  limitations: string[];
  methodology: string;
};

// ---------------------------------------------------------------------------
// Backtest (mirror of backend/backtest.py::run_backtest)
// ---------------------------------------------------------------------------
//
// Every headline number in this payload arrives with its baseline, because the
// endpoint refuses to publish a hit rate without one. The types below keep that
// pairing explicit: `BacktestRate` is never rendered without the `uniform` and
// `random` rates sitting beside it in `BacktestChannelReport`.

export type BacktestChannel = 'top' | 'bottom';

/** Hits and rates for one strategy (the AI, or the simulated random player). */
export type BacktestRate = {
  exact_hits: number;
  /** Null only when nothing was scored — never rendered as 0%. */
  exact_hit_rate_percent: number | null;
  top_5_hits: number;
  top_5_hit_rate_percent: number | null;
};

/** What the models were never shown, stated rather than implied. */
export type BacktestExcludedModel = { model: string; reason: string };

export type BacktestTimelinePoint = {
  draw_date: string;
  /** Draws scored so far, 1-based — the x-axis of the cumulative chart. */
  draws: number;
  actual: string;
  pick: string;
  ai_exact_rate_percent: number | null;
  random_exact_rate_percent: number | null;
  ai_top_5_rate_percent: number | null;
  random_top_5_rate_percent: number | null;
  exact_hit: number;
  top_5_hit: number;
};

export type BacktestEquityPoint = {
  draw_date: string;
  draws: number;
  ai_net_units: number;
  random_net_units: number;
};

export type BacktestRoiLeg = {
  staked: number;
  returned: number;
  net: number;
  roi_percent: number | null;
};

export type BacktestRoi = {
  payout_multiple: number;
  stake_per_pick_units: number;
  /** The hit rate a strategy must beat to break even at this payout. */
  break_even_hit_rate_percent: number;
  exact: { strategy: string; ai: BacktestRoiLeg; random: BacktestRoiLeg };
  cover: {
    strategy: string;
    picks_per_draw: number;
    ai: BacktestRoiLeg;
    random: BacktestRoiLeg;
  };
};

/** The significance test that stops a small sample being read as proof. */
export type BacktestSkill = {
  exact_lift_vs_uniform: number | null;
  top_5_lift_vs_uniform: number | null;
  exact_p_value: number;
  top_5_p_value: number;
  exact_significant: boolean;
  top_5_significant: boolean;
  alpha: number;
  /** Hits this window would need to clear `alpha`; null if it never could. */
  exact_hits_needed: number | null;
  top_5_hits_needed: number | null;
};

export type BacktestChannelReport = {
  /** False for a channel this ledger cannot derive — Vietnam's 5-digit `top`. */
  available: boolean;
  reason?: string;
  draws?: number;
  ai?: BacktestRate;
  random?: BacktestRate & { seed: number };
  uniform?: { exact_hit_rate_percent: number; top_5_hit_rate_percent: number };
  skill?: BacktestSkill;
  timeline?: BacktestTimelinePoint[];
  equity?: BacktestEquityPoint[];
  roi?: BacktestRoi;
};

export type BacktestPosition = {
  hits: number;
  predictions: number;
  hit_rate_percent: number | null;
  baseline_percent: number;
  lift_vs_uniform: number | null;
  p_value: number;
  significant: boolean;
  hits_needed: number | null;
};

export type BacktestPositional = {
  model: string;
  draws: number;
  /** Keyed by position, in the model's reading order. */
  positions: Partial<Record<PositionKey, BacktestPosition>>;
  overall: BacktestPosition;
  timeline: {
    draw_date: string;
    draws: number;
    predictions: number;
    hits: number;
    hit_rate_percent: number | null;
    baseline_percent: number;
  }[];
};

export type BacktestEconomy = {
  payout_multiple: number;
  payout_basis: string;
  break_even_hit_rate_percent: number | null;
  assumption: string;
};

export type Backtest = {
  status: PredictionStatus;
  engine: string;
  lottery_type: LotteryType;
  prize_digits: number;
  draws_requested: number;
  /** Less than `draws_requested` when the ledger is short — shown, not hidden. */
  draws_evaluated: number;
  train_window: number;
  top_k: number;
  date_range: { from: string | null; to: string | null };
  train_sizes: { min: number; max: number };
  leakage_guard: string;
  models: string[];
  models_excluded: BacktestExcludedModel[];
  economy: BacktestEconomy;
  random_baseline: {
    method: string;
    seed: number;
    expected_exact_rate_percent: number;
    expected_top_5_rate_percent: number;
  };
  /** Keyed by channel. A ledger may publish one, both, or neither. */
  channels: Partial<Record<BacktestChannel, BacktestChannelReport>>;
  positional: BacktestPositional;
  power: {
    draws: number;
    exact_hits_needed: number | null;
    top_5_hits_needed: number | null;
    note: string;
  };
  warnings: string[];
  methodology: string;
};

// ---------------------------------------------------------------------------
// Account and checkout
// ---------------------------------------------------------------------------

/**
 * The caller's own account, as `GET /api/me` reports it.
 *
 * `is_premium` is the server's verdict, computed from the tier *and* the expiry
 * together. The client deliberately does not recompute it from
 * `subscription_expiry`: two implementations of "is this still valid" is two
 * places for the boundary to disagree, and the one that matters is the server's.
 */
export type AccountStatus = {
  authenticated: boolean;
  user_id: string;
  email: string | null;
  subscription_tier: 'free' | 'premium';
  subscription_expiry: string | null;
  subscription_provider: string | null;
  is_premium: boolean;
  /** True when no `user_profiles` row exists — an account predating the schema. */
  profile_missing: boolean;
  /**
   * The status the gated endpoints would answer with: `null` when entitled, 402
   * when lapsed, 403 when never subscribed. Sent by the server so the app can say
   * "renew" or "subscribe" without first collecting a failure.
   */
  refusal_status: number | null;
};

/** One purchasable plan. `amount_minor` is an integer in the currency's minor unit. */
export type CheckoutPlan = {
  id: string;
  tier: string;
  name: string;
  amount_minor: number;
  amount_display: string;
  currency: string;
  interval: string;
  period_days: number;
};

/**
 * The price list, plus whether anything is actually purchasable.
 *
 * `live` is the field to branch on. Prices are shown either way — a user deciding
 * whether to sign up needs to know what it will cost — but the button must not
 * promise a purchase while `live` is false.
 */
export type CheckoutCatalogue = {
  provider: string | null;
  live: boolean;
  currency: string;
  plans: CheckoutPlan[];
};

/**
 * The answer to `POST /api/checkout/create-session`.
 *
 * Two outcomes, and `status` is what to branch on:
 *
 * - `'created'` — a real, payable Stripe session. `checkout_url` is where to send
 *   the customer. **No money has moved**: they still have to complete the payment
 *   on Stripe's page, and access is granted by the webhook when Stripe confirms,
 *   not by returning to the app.
 * - `'not_implemented'` — no gateway is configured on this server, so there is no
 *   session to open and `checkout_url` is null.
 *
 * `charged` and `subscription_granted` are **false in both cases**, always: this
 * endpoint creates a payment page, it never takes money and never grants access.
 * Read them before showing any success UI — a client that does cannot display a
 * purchase that did not happen, whatever the server or a future change does.
 */
export type CheckoutSession = {
  status: string;
  provider: string | null;
  live_mode: boolean;
  /** Empty, never a placeholder id, when no session exists. */
  session_id: string;
  checkout_url: string | null;
  /** ISO-8601 UTC. When the payment link stops working, or null if there is none. */
  expires_at: string | null;
  /**
   * What Stripe says the session actually offers, read back from its response
   * rather than echoed from the request. If the account is not eligible for a
   * method — PromptPay needs a Thailand-registered account — it is absent here,
   * which is where that becomes visible instead of being an unexplained gap on
   * the payment page.
   */
  payment_method_types: string[];
  /** What will be charged, in the currency's minor unit. 9900 is ฿99.00. */
  amount_minor: number | null;
  currency: string | null;
  user_id: string;
  plan: CheckoutPlan;
  charged: boolean;
  subscription_granted: boolean;
  already_premium: boolean;
  message: string;
};

/**
 * A fresh key identifying one *purchase intent*, for `POST /api/checkout/create-session`.
 *
 * The transport retries a request that timed out or met a booting server. A retried
 * `create-session` without this would open a **second payable session**, so a
 * customer on a flaky connection could end up looking at two checkout pages for one
 * purchase. Sending the same key again makes Stripe return the session it already
 * created instead.
 *
 * Generate one per tap, not per request: two taps really are two intents, and
 * deduplicating those would be wrong.
 *
 * The fallback exists because WebCrypto is not present in every JS runtime this
 * app can run in, and a payment button that throws before it can even ask is worse
 * than a weaker identifier. It is not a security boundary — the value only has to
 * be unlikely to collide within one user's attempts, and the server rejects
 * anything outside `[A-Za-z0-9_-]` regardless.
 */
export function newIdempotencyKey(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();

  const random = Math.random().toString(36).slice(2);
  const more = Math.random().toString(36).slice(2);
  return `idem-${Date.now().toString(36)}-${random}${more}`.slice(0, 64);
}

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

/**
 * Narrows the echoed ledger to a known country, defaulting to Thai.
 *
 * The default is the same one the backend applies, so a response that predates
 * this field (or a proxy that dropped it) renders as the Thai analysis rather
 * than as an unknown country.
 */
function toLotteryType(value: unknown): LotteryType {
  return typeof value === 'string' && (LOTTERY_TYPES as readonly string[]).includes(value)
    ? (value as LotteryType)
    : 'thai';
}

/**
 * Normalises the draw ledger, dropping rows a replay cannot use.
 *
 * The endpoint selects `*`, so a future column is fine; a row missing its date or a
 * two-digit result is not, because the heatmap's whole sample is those two fields.
 * Malformed rows are skipped rather than throwing: one bad insertion must not blank
 * the ledger's history, and the remaining rows are still exactly what was published.
 */
export function parseLatestDraws(body: unknown): LatestDrawRow[] {
  if (!Array.isArray(body)) {
    throw new ApiError('malformed', 'The draw service returned a non-list body.');
  }

  const rows: LatestDrawRow[] = [];
  for (const raw of body) {
    const row = asRecord(raw);
    if (!row) continue;
    const date = asString(row.draw_date);
    const bottomTwo = asString(row.bottom_two);
    if (!date || !/^\d{2}$/.test(bottomTwo)) continue;
    rows.push({
      date,
      firstPrize: asString(row.first_prize),
      bottomTwo,
      lotteryType: toLotteryType(row.lottery_type),
    });
  }
  return rows;
}

function asBasis(value: unknown): PositionBasis {
  return value === 'marginal' ? 'marginal' : 'conditional';
}

/**
 * Guards a position key, used for the leading digit's null `conditioned_on`.
 *
 * This is intentionally a membership test against `POSITION_KEYS` rather than a
 * coercion: an unrecognised value must read as "no conditioning position", never
 * as a position name the UI would then print as if the server had sent it.
 */
function isPositionKey(value: unknown): value is PositionKey {
  return typeof value === 'string' && (POSITION_KEYS as readonly string[]).includes(value);
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

/**
 * Reads a `model_statuses` object into a display-ordered list.
 *
 * The payload is keyed by model, but nothing guarantees a browser or Hermes
 * preserves key insertion order, so the list is rebuilt in `MODEL_KEYS` order.
 * A model the backend did not send is **skipped**, not defaulted: rendering an
 * absent model as a confident "neutral" would invent a finding about a model
 * that was never asked.
 */
function toModelStatuses(raw: unknown): ModelStatus[] {
  const rows = asRecord(raw);
  if (!rows) return [];

  const statuses: ModelStatus[] = [];
  for (const key of MODEL_KEYS) {
    const row = asRecord(rows[key]);
    if (!row) continue;
    statuses.push({
      key: key as ModelKey,
      label: asString(row.label, MODEL_LABELS[key]),
      status: row.status === 'active' ? 'active' : 'neutral',
      weight: asNumber(row.weight),
      reason: asString(row.reason, 'not_reported'),
      detail: asString(row.detail),
    });
  }
  return statuses;
}

function toApiRanking(raw: unknown): ApiRanking | null {
  const row = asRecord(raw);
  if (!row || typeof row.code !== 'string') return null;
  const evidence = asRecord(row.evidence) ?? {};
  return {
    code: row.code,
    modelStatuses: toModelStatuses(row.model_statuses),
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
    modelStatuses: toModelStatuses(channel.model_statuses),
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

function toAccuracyDigit(raw: unknown): AccuracyDigit | null {
  const row = asRecord(raw);
  if (!row || typeof row.digit !== 'string') return null;
  return { digit: row.digit, probability: asRateOrNull(row.probability) };
}

function toAccuracyPosition(raw: unknown): AccuracyPosition | null {
  const row = asRecord(raw);
  // A position without a name or an actual digit cannot be rendered at all, so it is
  // dropped rather than shown half-empty. `predicted: null` is different — that is a
  // position the model declined to rank, and it belongs on screen.
  if (!row || !isPositionKey(row.name) || typeof row.actual !== 'string') return null;

  return {
    name: row.name,
    index: asNumber(row.index),
    actual: row.actual,
    predicted: typeof row.predicted === 'string' ? row.predicted : null,
    hit: row.hit === true,
    in_top: row.in_top === true,
    actual_rank: typeof row.actual_rank === 'number' ? row.actual_rank : null,
    top: (Array.isArray(row.top) ? row.top : [])
      .map(toAccuracyDigit)
      .filter((entry): entry is AccuracyDigit => entry !== null),
    support: asNumber(row.support),
    basis: asBasis(row.basis),
  };
}

function toAccuracyChannel(raw: unknown): AccuracyChannel | null {
  const row = asRecord(raw);
  if (!row) return null;
  return {
    available: row.available === true,
    actual: typeof row.actual === 'string' ? row.actual : null,
    picks: (Array.isArray(row.picks) ? row.picks : []).filter(
      (item): item is string => typeof item === 'string'
    ),
    predicted: typeof row.predicted === 'string' ? row.predicted : null,
    exact_hit: row.exact_hit === true,
    in_top_5: row.in_top_5 === true,
    reason: typeof row.reason === 'string' ? row.reason : null,
  };
}

function toAccuracyComparison(raw: unknown): AccuracyComparison | null {
  const row = asRecord(raw);
  if (!row) return null;

  const channels: Partial<Record<ChannelKey, AccuracyChannel>> = {};
  const rawChannels = asRecord(row.channels) ?? {};
  for (const channel of ['top', 'bottom'] as const) {
    const parsed = toAccuracyChannel(rawChannels[channel]);
    if (parsed) channels[channel] = parsed;
  }

  return {
    draw_date: asString(row.draw_date),
    first_prize: asString(row.first_prize),
    bottom_two: asString(row.bottom_two),
    top_two: typeof row.top_two === 'string' ? row.top_two : null,
    train_size: asNumber(row.train_size),
    positions: (Array.isArray(row.positions) ? row.positions : [])
      .map(toAccuracyPosition)
      .filter((entry): entry is AccuracyPosition => entry !== null),
    position_hits: asNumber(row.position_hits),
    position_in_top: asNumber(row.position_in_top),
    position_predictions: asNumber(row.position_predictions),
    channels,
  };
}

/**
 * A rate, read with `asRateOrNull` throughout.
 *
 * `asNumber` defaults to 0, which is right for a count and catastrophic for a rate: a
 * missing hit rate would render as "0%", which reads as a model that failed rather
 * than as a number the server did not send. The baseline is the exception and does
 * default — a rate with no baseline is a claim, and every backend rate has one.
 */
function toAccuracyRate(raw: unknown): AccuracyRate {
  const row = asRecord(raw) ?? {};
  return {
    hits: asNumber(row.hits),
    predictions: asNumber(row.predictions),
    hit_rate_percent: asRateOrNull(row.hit_rate_percent),
    // The 10% positional baseline is the fallback only for a malformed payload: a
    // real response always states it, and the UI renders whatever it says rather
    // than a constant compiled into the client.
    baseline_percent: asNumber(row.baseline_percent, 10),
    lift_vs_uniform: asRateOrNull(row.lift_vs_uniform),
    p_value: asNumber(row.p_value),
    significant: row.significant === true,
    hits_needed: typeof row.hits_needed === 'number' ? row.hits_needed : null,
    alpha: asNumber(row.alpha, 0.05),
  };
}

function toAccuracyChannelReport(raw: unknown): AccuracyChannelReport | null {
  const row = asRecord(raw);
  if (!row) return null;

  const report: AccuracyChannelReport = {
    available: row.available === true,
    draws: asNumber(row.draws),
  };
  if (row.exact !== undefined) report.exact = toAccuracyRate(row.exact);
  if (row.in_top_5 !== undefined) report.in_top_5 = toAccuracyRate(row.in_top_5);
  if (typeof row.picks_per_draw === 'number') report.picks_per_draw = row.picks_per_draw;
  if (typeof row.reason === 'string') report.reason = row.reason;
  return report;
}

/**
 * Validates and normalises the `/api/premium/accuracy-report` payload.
 *
 * Tolerant in the same place the other parsers are: an empty ledger is a successful
 * `insufficient_data` answer with `comparisons: []`, so it has to render as an empty
 * state rather than as a parse failure. Strict about the one thing the card cannot
 * exist without — a comparison whose positions it can draw — because a card that
 * renders "0/0 positions" from a malformed payload would look like a result.
 */
export function parseAccuracyReport(body: unknown): AccuracyReport {
  const root = asRecord(body);
  if (!root) {
    throw new ApiError('malformed', 'The accuracy service returned a non-object body.');
  }

  const accuracy = asRecord(root.accuracy) ?? {};
  const positional = asRecord(accuracy.positional) ?? {};
  const rawPositions = asRecord(positional.positions) ?? {};

  const positions: Partial<Record<PositionKey, AccuracyRate>> = {};
  for (const key of POSITION_KEYS) {
    if (rawPositions[key] !== undefined) positions[key] = toAccuracyRate(rawPositions[key]);
  }

  const channels: Partial<Record<ChannelKey, AccuracyChannelReport>> = {};
  const rawChannels = asRecord(accuracy.channels) ?? {};
  for (const channel of ['top', 'bottom'] as const) {
    const report = toAccuracyChannelReport(rawChannels[channel]);
    if (report) channels[channel] = report;
  }

  const range = asRecord(root.date_range) ?? {};
  const trainSizes = asRecord(root.train_sizes) ?? {};

  return {
    status: toStatus(root.status),
    lottery_type: toLotteryType(root.lottery_type),
    prize_digits: asNumber(root.prize_digits, 6),
    model: 'bayesian_positional',
    draws_requested: asNumber(root.draws_requested),
    draws_evaluated: asNumber(root.draws_evaluated),
    train_window: asNumber(root.train_window),
    top_k: asNumber(root.top_k, 5),
    prediction_basis: asString(root.prediction_basis, 'walk_forward_replay'),
    replay_notice: asString(root.replay_notice),
    comparisons: (Array.isArray(root.comparisons) ? root.comparisons : [])
      .map(toAccuracyComparison)
      .filter((entry): entry is AccuracyComparison => entry !== null),
    accuracy: {
      positional: {
        model: 'bayesian_positional',
        draws: asNumber(positional.draws),
        prize_digits: asNumber(positional.prize_digits, 6),
        positions,
        overall: toAccuracyRate(positional.overall),
      },
      channels,
    },
    date_range: {
      from: typeof range.from === 'string' ? range.from : null,
      to: typeof range.to === 'string' ? range.to : null,
    },
    train_sizes: {
      min: asNumber(trainSizes.min),
      max: asNumber(trainSizes.max),
    },
    warnings: (Array.isArray(root.warnings) ? root.warnings : []).filter(
      (item): item is string => typeof item === 'string'
    ),
    limitations: (Array.isArray(root.limitations) ? root.limitations : []).filter(
      (item): item is string => typeof item === 'string'
    ),
    methodology: asString(root.methodology),
  };
}

function toPositionalEstimate(name: PositionKey, raw: unknown): PositionalEstimate | null {
  const row = asRecord(raw);
  if (!row) return null;
  return {
    name,
    label: asString(row.label, name),
    index: asNumber(row.index),
    conditioned_on: isPositionKey(row.conditioned_on) ? row.conditioned_on : null,
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
    lottery_type: toLotteryType(root.lottery_type),
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

/**
 * A rate read without a fallback, so an absent number stays `null`.
 *
 * `asNumber` defaults to 0, which is right for counts and catastrophic for rates:
 * a missing hit rate would render as "0%", which reads as a model that failed
 * rather than as a field that was not sent. Every percentage in the backtest
 * payload goes through here instead.
 */
function asRateOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecordList(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);
}

function toBacktestRate(raw: unknown): BacktestRate {
  const row = asRecord(raw) ?? {};
  return {
    exact_hits: asNumber(row.exact_hits),
    exact_hit_rate_percent: asRateOrNull(row.exact_hit_rate_percent),
    top_5_hits: asNumber(row.top_5_hits),
    top_5_hit_rate_percent: asRateOrNull(row.top_5_hit_rate_percent),
  };
}

function toBacktestSkill(raw: unknown): BacktestSkill | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  return {
    exact_lift_vs_uniform: asRateOrNull(row.exact_lift_vs_uniform),
    top_5_lift_vs_uniform: asRateOrNull(row.top_5_lift_vs_uniform),
    exact_p_value: asNumber(row.exact_p_value, 1),
    top_5_p_value: asNumber(row.top_5_p_value, 1),
    exact_significant: row.exact_significant === true,
    top_5_significant: row.top_5_significant === true,
    alpha: asNumber(row.alpha, 0.05),
    exact_hits_needed: asRateOrNull(row.exact_hits_needed),
    top_5_hits_needed: asRateOrNull(row.top_5_hits_needed),
  };
}

function toBacktestRoiLeg(raw: unknown): BacktestRoiLeg {
  const row = asRecord(raw) ?? {};
  return {
    staked: asNumber(row.staked),
    returned: asNumber(row.returned),
    net: asNumber(row.net),
    roi_percent: asRateOrNull(row.roi_percent),
  };
}

function toBacktestRoi(raw: unknown): BacktestRoi | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  const exact = asRecord(row.exact) ?? {};
  const cover = asRecord(row.cover) ?? {};
  return {
    payout_multiple: asNumber(row.payout_multiple),
    stake_per_pick_units: asNumber(row.stake_per_pick_units, 1),
    break_even_hit_rate_percent: asNumber(row.break_even_hit_rate_percent),
    exact: {
      strategy: asString(exact.strategy),
      ai: toBacktestRoiLeg(exact.ai),
      random: toBacktestRoiLeg(exact.random),
    },
    cover: {
      strategy: asString(cover.strategy),
      picks_per_draw: asNumber(cover.picks_per_draw),
      ai: toBacktestRoiLeg(cover.ai),
      random: toBacktestRoiLeg(cover.random),
    },
  };
}

function toChannelReport(raw: unknown): BacktestChannelReport | null {
  const row = asRecord(raw);
  if (!row) return null;

  const uniform = asRecord(row.uniform);
  const timeline = asRecordList(row.timeline).map((point) => ({
    draw_date: asString(point.draw_date),
    draws: asNumber(point.draws),
    actual: asString(point.actual),
    pick: asString(point.pick),
    ai_exact_rate_percent: asRateOrNull(point.ai_exact_rate_percent),
    random_exact_rate_percent: asRateOrNull(point.random_exact_rate_percent),
    ai_top_5_rate_percent: asRateOrNull(point.ai_top_5_rate_percent),
    random_top_5_rate_percent: asRateOrNull(point.random_top_5_rate_percent),
    exact_hit: asNumber(point.exact_hit),
    top_5_hit: asNumber(point.top_5_hit),
  }));

  return {
    available: row.available === true,
    ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
    ...(row.draws === undefined ? {} : { draws: asNumber(row.draws) }),
    // A channel can legitimately be unavailable, in which case it carries only a
    // reason. The optional metrics are therefore omitted rather than defaulted,
    // so the UI cannot render a 0% for a channel that was never scored.
    ...(row.ai === undefined ? {} : { ai: toBacktestRate(row.ai) }),
    ...(row.random === undefined
      ? {}
      : {
          random: {
            ...toBacktestRate(row.random),
            seed: asNumber(asRecord(row.random)?.seed),
          },
        }),
    ...(uniform
      ? {
          uniform: {
            exact_hit_rate_percent: asNumber(uniform.exact_hit_rate_percent),
            top_5_hit_rate_percent: asNumber(uniform.top_5_hit_rate_percent),
          },
        }
      : {}),
    ...(row.skill === undefined ? {} : { skill: toBacktestSkill(row.skill) }),
    ...(timeline.length ? { timeline } : {}),
    ...(Array.isArray(row.equity)
      ? {
          equity: asRecordList(row.equity).map((point) => ({
            draw_date: asString(point.draw_date),
            draws: asNumber(point.draws),
            ai_net_units: asNumber(point.ai_net_units),
            random_net_units: asNumber(point.random_net_units),
          })),
        }
      : {}),
    ...(row.roi === undefined ? {} : { roi: toBacktestRoi(row.roi) }),
  };
}

function toBacktestPosition(raw: unknown): BacktestPosition | null {
  const row = asRecord(raw);
  if (!row) return null;
  return {
    hits: asNumber(row.hits),
    predictions: asNumber(row.predictions),
    hit_rate_percent: asRateOrNull(row.hit_rate_percent),
    baseline_percent: asNumber(row.baseline_percent, 10),
    lift_vs_uniform: asRateOrNull(row.lift_vs_uniform),
    p_value: asNumber(row.p_value, 1),
    significant: row.significant === true,
    hits_needed: asRateOrNull(row.hits_needed),
  };
}

/**
 * Validates and normalises the `/api/backtest` payload.
 *
 * Tolerant in the same places `parsePremiumInsights` is: an empty ledger is a
 * successful `insufficient_data` response, not an error, so the parser must not
 * demand a channel or a metric that a legitimate empty answer omits. It is
 * strict about the alternative — a rate without its baseline — because a hit
 * rate rendered alone is exactly the claim this endpoint exists to prevent.
 */
export function parseBacktest(body: unknown): Backtest {
  const root = asRecord(body);
  if (!root) {
    throw new ApiError('malformed', 'The backtest service returned a non-object body.');
  }

  const rawChannels = asRecord(root.channels) ?? {};
  const channels: Partial<Record<BacktestChannel, BacktestChannelReport>> = {};
  for (const channel of ['top', 'bottom'] as const) {
    const report = toChannelReport(rawChannels[channel]);
    if (report) channels[channel] = report;
  }

  const rawPositional = asRecord(root.positional) ?? {};
  const rawPositions = asRecord(rawPositional.positions) ?? {};
  const positions: Partial<Record<PositionKey, BacktestPosition>> = {};
  for (const key of POSITION_KEYS) {
    const position = toBacktestPosition(rawPositions[key]);
    if (position) positions[key] = position;
  }

  const range = asRecord(root.date_range) ?? {};
  const trainSizes = asRecord(root.train_sizes) ?? {};
  const economy = asRecord(root.economy) ?? {};
  const baseline = asRecord(root.random_baseline) ?? {};
  const power = asRecord(root.power) ?? {};

  return {
    status: toStatus(root.status),
    engine: asString(root.engine),
    lottery_type: toLotteryType(root.lottery_type),
    prize_digits: asNumber(root.prize_digits, 6),
    draws_requested: asNumber(root.draws_requested),
    draws_evaluated: asNumber(root.draws_evaluated),
    train_window: asNumber(root.train_window),
    top_k: asNumber(root.top_k, 5),
    date_range: {
      from: typeof range.from === 'string' ? range.from : null,
      to: typeof range.to === 'string' ? range.to : null,
    },
    train_sizes: { min: asNumber(trainSizes.min), max: asNumber(trainSizes.max) },
    leakage_guard: asString(root.leakage_guard),
    models: (Array.isArray(root.models) ? root.models : []).filter(
      (item): item is string => typeof item === 'string'
    ),
    models_excluded: asRecordList(root.models_excluded).map((row) => ({
      model: asString(row.model),
      reason: asString(row.reason),
    })),
    economy: {
      payout_multiple: asNumber(economy.payout_multiple, 100),
      payout_basis: asString(economy.payout_basis),
      break_even_hit_rate_percent: asRateOrNull(economy.break_even_hit_rate_percent),
      assumption: asString(economy.assumption),
    },
    random_baseline: {
      method: asString(baseline.method),
      seed: asNumber(baseline.seed),
      expected_exact_rate_percent: asNumber(baseline.expected_exact_rate_percent, 1),
      expected_top_5_rate_percent: asNumber(baseline.expected_top_5_rate_percent, 5),
    },
    channels,
    positional: {
      model: asString(rawPositional.model),
      draws: asNumber(rawPositional.draws),
      positions,
      overall:
        toBacktestPosition(rawPositional.overall) ?? {
          hits: 0,
          predictions: 0,
          hit_rate_percent: null,
          baseline_percent: 10,
          lift_vs_uniform: null,
          p_value: 1,
          significant: false,
          hits_needed: null,
        },
      timeline: asRecordList(rawPositional.timeline).map((point) => ({
        draw_date: asString(point.draw_date),
        draws: asNumber(point.draws),
        predictions: asNumber(point.predictions),
        hits: asNumber(point.hits),
        hit_rate_percent: asRateOrNull(point.hit_rate_percent),
        baseline_percent: asNumber(point.baseline_percent, 10),
      })),
    },
    power: {
      draws: asNumber(power.draws),
      exact_hits_needed: asRateOrNull(power.exact_hits_needed),
      top_5_hits_needed: asRateOrNull(power.top_5_hits_needed),
      note: asString(power.note),
    },
    warnings: (Array.isArray(root.warnings) ? root.warnings : []).filter(
      (item): item is string => typeof item === 'string'
    ),
    methodology: asString(root.methodology),
  };
}

function toCheckoutPlan(raw: unknown): CheckoutPlan | null {
  const row = asRecord(raw);
  if (!row) return null;
  const id = asString(row.id);
  // A plan without an id cannot be requested, so it is dropped rather than
  // rendered as a price the user could tap and get a 422 for.
  if (!id) return null;
  return {
    id,
    tier: asString(row.tier, 'premium'),
    name: asString(row.name, id),
    amount_minor: asNumber(row.amount_minor),
    amount_display: asString(row.amount_display),
    currency: asString(row.currency, 'THB'),
    interval: asString(row.interval, 'month'),
    period_days: asNumber(row.period_days),
  };
}

/**
 * Validates the `/api/checkout/plans` payload.
 *
 * `live` is only true when the server explicitly said `true`. It decides whether
 * the app offers a real purchase, so an absent or malformed value has to read as
 * "do not sell" rather than "sell".
 */
export function parseCheckoutCatalogue(body: unknown): CheckoutCatalogue {
  const root = asRecord(body);
  if (!root) {
    throw new ApiError('malformed', 'The checkout service returned a non-object body.');
  }

  return {
    provider: typeof root.provider === 'string' ? root.provider : null,
    live: root.live === true,
    currency: asString(root.currency, 'THB'),
    plans: (Array.isArray(root.plans) ? root.plans : [])
      .map(toCheckoutPlan)
      .filter((plan): plan is CheckoutPlan => plan !== null),
  };
}

/**
 * Validates the `/api/me` payload.
 *
 * The tier is narrowed to the two known values rather than passed through, so a
 * tier this build does not recognise reads as `free` and the UI cannot open a
 * premium panel for something it does not understand.
 */
export function parseAccount(body: unknown): AccountStatus {
  const root = asRecord(body);
  if (!root) {
    throw new ApiError('malformed', 'The account service returned a non-object body.');
  }

  return {
    authenticated: root.authenticated === true,
    user_id: asString(root.user_id),
    email: typeof root.email === 'string' ? root.email : null,
    subscription_tier: root.subscription_tier === 'premium' ? 'premium' : 'free',
    subscription_expiry:
      typeof root.subscription_expiry === 'string' ? root.subscription_expiry : null,
    subscription_provider:
      typeof root.subscription_provider === 'string' ? root.subscription_provider : null,
    is_premium: root.is_premium === true,
    profile_missing: root.profile_missing === true,
    refusal_status: typeof root.refusal_status === 'number' ? root.refusal_status : null,
  };
}

/**
 * Validates the `/api/checkout/create-session` payload.
 *
 * Strict in the one place that matters. A status is required, and the two flags
 * that say whether money moved are only ever `true` when the server said `true`.
 * Everything else defaults to the pessimistic side, because the failure this parser
 * exists to prevent is a client showing a completed purchase for a request that
 * sold nothing.
 */
export function parseCheckoutSession(body: unknown): CheckoutSession {
  const root = asRecord(body);
  if (!root) {
    throw new ApiError('malformed', 'The checkout service returned a non-object body.');
  }

  const plan = toCheckoutPlan(root.plan);
  if (!plan) {
    throw new ApiError('malformed', 'The checkout response did not name a plan.');
  }

  const status = asString(root.status);
  if (!status) {
    throw new ApiError('malformed', 'The checkout response had no status.');
  }

  return {
    status,
    provider: typeof root.provider === 'string' ? root.provider : null,
    live_mode: root.live_mode === true,
    session_id: asString(root.session_id),
    // An empty string is normalised to null: the two mean the same thing, and one
    // of them (`''`) is falsey while `null` is explicit, so normalising here saves
    // every caller from testing both.
    checkout_url: typeof root.checkout_url === 'string' && root.checkout_url ? root.checkout_url : null,
    expires_at: typeof root.expires_at === 'string' ? root.expires_at : null,
    payment_method_types: (Array.isArray(root.payment_method_types)
      ? root.payment_method_types
      : []
    ).filter((method): method is string => typeof method === 'string'),
    amount_minor: typeof root.amount_minor === 'number' ? root.amount_minor : null,
    currency: typeof root.currency === 'string' ? root.currency : null,
    user_id: asString(root.user_id),
    plan,
    charged: root.charged === true,
    subscription_granted: root.subscription_granted === true,
    already_premium: root.already_premium === true,
    message: asString(root.message),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** One HTTP round trip, bounded by `timeoutMs`. */
async function attempt(
  path: string,
  timeoutMs: number,
  options: RequestOptions = {}
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  // Set only when there is a body: sending `Content-Type: application/json` on a
  // GET makes the request non-simple, so the browser preflights it for nothing.
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError(
          'timeout',
          `The prediction service at ${BASE_URL} did not answer within ` +
            `${Math.round(timeoutMs / 1000)}s.`
        );
      }
      // `fetch` rejects with a bare `TypeError` for anything it cannot turn into
      // a response: a refused connection, DNS failure, or a response the browser
      // blocked because the proxy returned a 502 with no CORS header — which is
      // the normal shape of a cold Render instance. Classified here rather than
      // left raw for two reasons: `isRetryable` can only recognise an `ApiError`,
      // so an unclassified rejection was never retried and a waking server was
      // reported as offline; and an unclassified error reaches the reader as
      // "unexpected", which blames the app for the network.
      throw new ApiError(
        'network',
        `The connection to ${BASE_URL} failed before a response arrived ` +
          `(${error instanceof Error ? error.message : String(error)}).`
      );
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether a failure is worth retrying. Only three shapes qualify, and none is an
 * answer from this application:
 *
 * - `timeout` — the request hung. Render's proxy parks the connection while a
 *   spun-down instance boots, so silence *is* what waking looks like from here.
 * - `502`/`503`/`504` — the proxy answered because the app could not: still
 *   booting, or being swapped out mid-deploy.
 * - `network` — the response never arrived in a readable form, which in a browser
 *   is the *usual* face of a cold start rather than an exception: a 502 from the
 *   proxy is served without CORS headers, so the browser rejects the fetch before
 *   any status can be read. Not retried against a local address — see
 *   `NO_RETRY_HOSTS`.
 *
 * Everything else fails immediately on purpose. A 4xx/5xx from FastAPI itself is a
 * real answer, and retrying it for a minute would only postpone the error card.
 */
function isRetryable(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.kind === 'timeout') return true;
  if (error.kind === 'network') return !isLocalTarget();
  return (
    error.kind === 'http' && error.status !== undefined && error.status >= 502 && error.status <= 504
  );
}

/**
 * Pause before the next attempt, per failure shape: fixed for a network failure,
 * the rising table for everything else.
 */
function retryDelayMs(kind: ApiErrorKind | null, attemptNumber: number): number {
  if (kind === 'network') return NETWORK_RETRY_INTERVAL_MS;
  return RETRY_BACKOFF_MS[Math.min(attemptNumber - 1, RETRY_BACKOFF_MS.length - 1)];
}

/**
 * The error reported once the budget is spent.
 *
 * A bare `timeout` message covers one attempt's window, which after several
 * attempts describes the last try rather than the minute the user actually
 * waited. Rewritten to span the whole run so the number on screen is the number
 * they sat through; other kinds already carry the server's own words.
 */
function exhausted(error: unknown, attempts: number, elapsedMs: number): unknown {
  if (!isApiError(error)) return error;
  if (error.kind !== 'timeout' && error.kind !== 'network') return error;

  const waited = `${Math.round(elapsedMs / 1000)}s (${attempts} attempts)`;
  const advice = isLocalTarget()
    ? 'No server is running at that address — start the backend, then Retry.'
    : 'A free instance that has spun down can take a minute or more to wake — Retry will try again.';

  return new ApiError(
    error.kind,
    error.kind === 'timeout'
      ? `The prediction service at ${BASE_URL} did not answer within ${waited}. ${advice}`
      : `The connection to ${BASE_URL} failed for ${waited}. A cold instance answers ` +
        `502s without CORS headers, which a browser reports as a blocked request. ${advice}`
  );
}

/**
 * One request, retried for as long as the failure looks like a sleeping server.
 *
 * This exists because the API runs on a free Render instance that spins down
 * after inactivity, and the dashboard's own warning puts waking it at "50 seconds
 * or more". A client that aborts once at 10s therefore reports a *healthy*
 * backend as unreachable on the first visit after a quiet spell — observed on
 * the deployed beta, where the same call answered in ~1.3s once warm. Spending
 * the budget in retries instead of one long wait also lets the caller say it is
 * waking the server rather than pretending it is offline.
 *
 * The deadline bounds when the *next* attempt may start, so the worst case is
 * one attempt past it.
 */
async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? WAKE_DEADLINE_MS;
  const startedAt = Date.now();

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt(path, attemptTimeoutMs, options);
    } catch (error) {
      const kind = isApiError(error) ? error.kind : null;
      const delayMs = retryDelayMs(kind, attemptNumber);
      const elapsedMs = Date.now() - startedAt;

      // A network failure is bounded by its own, shorter budget. `Math.min`
      // rather than a replacement so an explicit `deadlineMs` from a caller
      // (or a test) still wins when it is the tighter of the two.
      const budgetMs =
        kind === 'network' ? Math.min(deadlineMs, NETWORK_DEADLINE_MS) : deadlineMs;

      if (!isRetryable(error) || elapsedMs + delayMs >= budgetMs) {
        throw exhausted(error, attemptNumber, elapsedMs);
      }

      if (isApiError(error)) {
        options.onRetry?.({ attempt: attemptNumber + 1, elapsedMs, lastKind: error.kind });
      }
      await sleep(delayMs);
    }
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
 * @param limit How many of the **most recent** draws to analyse (2–400). Omit for
 * the full rolling window, which is what the dashboard wants; the backend caps it
 * at 400 and rejects anything larger rather than quietly clamping it.
 * @param options Per-request budgets, plus `onRetry` for a caller that wants to
 * announce that it is waiting on a cold server.
 */
export async function getBasicPredictions(
  limit?: number,
  options?: RequestOptions
): Promise<BasicPredictions> {
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
  return parsePredictions(await request(`/api/predict/basic${query}`, options));
}

/**
 * Bayesian positional posteriors for all six digits of รางวัลที่ 1 — the
 * Premium tier.
 *
 * Degrades exactly like `getBasicPredictions`: a thin or empty ledger resolves
 * with `status: 'limited'` / `'insufficient_data'`, `positions` empty or partial,
 * and `warnings` populated, so the caller renders an empty state instead of an
 * error. A rejection always means the call itself failed — see `ApiError.kind`.
 *
 * @param limit How many of the **most recent** draws to analyse (2–400). Omit for
 * the full rolling window; the backend caps it at 400 and rejects anything larger
 * rather than quietly clamping it.
 * @param options Per-request budgets, plus `onRetry` for a caller that wants to
 * announce that it is waiting on a cold server.
 */
export async function getPremiumInsights(
  limit?: number,
  options?: RequestOptions,
  /** Which country's ledger to analyse. Omit for the Thai lottery. */
  lotteryType: LotteryType = 'thai'
): Promise<PremiumInsights> {
  // `type` is always sent, even at its default, so the request that produced a
  // response is readable from it — including in the backend log, which records the
  // ledger it analysed.
  const params = new URLSearchParams({ type: lotteryType });
  if (limit !== undefined) params.set('limit', String(limit));
  return parsePremiumInsights(
    await request(`/api/predict/premium?${params.toString()}`, options)
  );
}

/**
 * Replay the last `draws` draws through the models, using only their own past.
 *
 * The result is a *measurement*, not a promise: every rate carries the closed-form
 * uniform baseline, the seeded random player's rate and a p-value, and
 * `draws_evaluated` may be smaller than `draws` when the ledger is short. Render it
 * exactly as returned — the endpoint refuses to publish a headline number without
 * its baseline, and the client must not undo that by showing one alone.
 *
 * @param lotteryType Which country's ledger to replay. `thai` by default.
 * @param draws How many of the most recent draws to replay (2–60). Omit for the
 * backend's default of 30; asking for more than a short ledger holds is reported
 * in `draws_evaluated` rather than failing.
 * @param options Per-request budgets, plus `onRetry` to announce a cold server.
 */
export async function getBacktest(
  lotteryType: LotteryType = 'thai',
  draws?: number,
  options?: RequestOptions
): Promise<Backtest> {
  // `type` is always sent, even at its default, so the response can be matched
  // against the ledger tab that asked for it — a late answer for Laos must not be
  // rendered under the Thai heading.
  const params = new URLSearchParams({ type: lotteryType });
  if (draws !== undefined) params.set('draws', String(draws));
  return parseBacktest(
    await request(`/api/backtest?${params.toString()}`, {
      attemptTimeoutMs: BACKTEST_TIMEOUT_MS,
      ...options,
    })
  );
}

/**
 * The most recent published draws, newest first.
 *
 * Used by the insights heatmap and by the performance screen's walk-forward signals:
 * both need the ledger itself, not a model's summary of it. The endpoint caps `limit`
 * at 100, so that is the widest window one request can ask for; a caller that needs
 * more history has to page by date, which the endpoint does not offer yet.
 *
 * @param limit How many of the most recent draws to return (1-100).
 * @param lotteryType Which country's ledger to read. `thai` by default.
 * @param options Per-request budgets, plus `onRetry` to announce a cold server.
 */
export async function getLatestDraws(
  limit = 100,
  lotteryType: LotteryType = 'thai',
  options?: RequestOptions
): Promise<LatestDrawRow[]> {
  const params = new URLSearchParams({ limit: String(limit), type: lotteryType });
  return parseLatestDraws(await request(`/api/latest-draws?${params.toString()}`, options));
}

/**
 * What the model said about each recent draw before it happened, beside the result.
 *
 * Premium: the endpoint requires `accessToken` and reads the subscription before
 * answering, so a free account gets a 403 and a lapsed one a 402 — the same refusals
 * `/api/predict/premium` produces.
 *
 * The result is a **replay**. Nothing stores a prediction when it is made, so the
 * server re-runs the model for each target draw using only the draws before it — and
 * `replay_notice` is the server's own sentence about that. Render it: showing a
 * reconstructed prediction as a recorded forecast would be a claim about the past
 * that nobody can check.
 *
 * @param lotteryType Which ledger to mark. `thai` by default.
 * @param draws How many recent draws to compare (1–20). Omit for the server default.
 * @param options Per-request budgets, plus `accessToken` — without it this is a 401.
 */
export async function getAccuracyReport(
  lotteryType: LotteryType = 'thai',
  draws?: number,
  options?: RequestOptions
): Promise<AccuracyReport> {
  // `type` is always sent, even at its default, so the ledger that produced a
  // response is readable from the request as well as from the answer — and so a
  // response that arrives after the reader changed country can be discarded.
  const params = new URLSearchParams({ type: lotteryType });
  if (draws !== undefined) params.set('draws', String(draws));
  return parseAccuracyReport(
    await request(`/api/premium/accuracy-report?${params.toString()}`, options)
  );
}

// ---------------------------------------------------------------------------
// Account and checkout endpoints
// ---------------------------------------------------------------------------

/**
 * The caller's own account and subscription state.
 *
 * Requires a token: signed out is a 401, not a 200 with `authenticated: false`.
 * That is deliberate on the server (one way to learn a token is dead) and it means
 * this function rejects with an `ApiError` whose `kind` is `'http'` and `status` is
 * 401 rather than resolving — callers should only call it when they hold a token.
 */
export async function getAccount(
  accessToken: string,
  options?: RequestOptions
): Promise<AccountStatus> {
  return parseAccount(await request('/api/me', { ...options, accessToken }));
}

/**
 * The subscription price list. Public — no token needed.
 *
 * Read the prices from here rather than hard-coding them in a screen: the number
 * shown and the number that would be charged come from one place this way.
 */
export async function getCheckoutPlans(options?: RequestOptions): Promise<CheckoutCatalogue> {
  return parseCheckoutCatalogue(await request('/api/checkout/plans', options));
}

/**
 * Ask the server to open a Stripe Checkout Session for this account.
 *
 * The answer carries a `checkout_url` when a gateway is configured, and says
 * outright that nothing was charged either way. Two things must be checked before
 * any success UI: `charged` and `subscription_granted` (always false), and
 * `checkout_url` (present only when there is somewhere to go).
 *
 * The account is taken from `accessToken`, never from the request: there is no
 * user-id parameter to send, by design.
 *
 * `options.returnOrigin` is the origin the customer should be sent back to after
 * paying. Omit it and the server uses its own configured default — which is what
 * the native targets do, since they are not served from an origin. See
 * `lib/checkout.ts` for why it is a request rather than a decision: the server
 * validates it against the same allow-list CORS uses and refuses anything else, so
 * a client cannot turn this into an open redirect.
 */
export async function createCheckoutSession(
  planId: string,
  accessToken: string,
  options?: RequestOptions & { returnOrigin?: string }
): Promise<CheckoutSession> {
  const { returnOrigin, ...rest } = options ?? {};

  return parseCheckoutSession(
    await request('/api/checkout/create-session', {
      ...rest,
      accessToken,
      method: 'POST',
      body: {
        plan: planId,
        // Generated here, once, so the retry loop inside `request` reuses the same
        // key for every attempt at this one purchase. See `newIdempotencyKey`.
        idempotency_key: newIdempotencyKey(),
        ...(returnOrigin ? { return_origin: returnOrigin } : {}),
      },
    })
  );
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
    modelStatuses: ranking.modelStatuses,
  };
}

/** Both markets, ready for `RANKINGS[market]`-style lookup. */
export function toRankings(predictions: BasicPredictions): Record<ChannelKey, RankEntry[]> {
  return {
    top: predictions.channels.top.rankings.map(toRankEntry),
    bottom: predictions.channels.bottom.rankings.map(toRankEntry),
  };
}
