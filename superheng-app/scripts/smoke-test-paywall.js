#!/usr/bin/env node
/**
 * Paywall smoke test — is the deployed API still able to sell?
 *
 * WHY THIS EXISTS
 *
 * Every way the paywall breaks looks the same from a browser: the button does
 * something unhelpful. On 2026-10-18 a wildcard `CORS_ORIGINS` with no
 * `FRONTEND_BASE_URL` refused *every* browser checkout with a 403, and the only way
 * it was found was a human paying with a test card. This checks the same ground in
 * about three seconds with no dashboard, no test card and no account.
 *
 * WHAT IT CHECKS, AND WHY EACH ONE
 *
 *   1. `GET /api/health` — the API answers at all, and says what it is.
 *   2. `GET /api/diagnostics/paywall` — the four things a completed payment needs:
 *      the gateway key, the webhook signing secret, the entitlement writer, and an
 *      origin a payment may return to. `degraded` is the dangerous half-state and
 *      fails here. `not_configured` — the honest "not open yet" state — also fails,
 *      unless `--allow-unconfigured` says this deployment is not selling yet.
 *   3. CORS, for the app's real origin: a preflight for `POST
 *      /api/create-checkout-session` must be allowed and must permit
 *      `authorization`. Without that the browser refuses the request before the
 *      button's own code runs — the failure that reads as "the button is broken"
 *      with nothing in the API's log to show for it.
 *   4. The checkout *route* itself, when a token is supplied. `SMOKE_TEST_TOKEN`
 *      makes this POST a real session and assert a payable `checkout_url`. That is
 *      the only check that exercises the route's own return-origin validation,
 *      because the route authenticates before it validates the origin: an anonymous
 *      caller can never reach that code, and a 401 proves nothing about it. Nothing
 *      is ever paid — the session is created and abandoned. Use a **test-mode** key
 *      server, or this creates a real payment page against a live account.
 *
 * USAGE
 *
 *   node scripts/smoke-test-paywall.js
 *   node scripts/smoke-test-paywall.js --api=http://127.0.0.1:8000 --allow-unconfigured
 *   SMOKE_TEST_TOKEN=<supabase access token> node scripts/smoke-test-paywall.js
 *
 * The defaults are the deployed beta, so the no-argument run is the one that
 * matters. `EXPO_PUBLIC_API_URL` overrides the API base, matching the app's own
 * configuration, and `EXPO_PUBLIC_APP_ORIGIN` overrides the origin.
 *
 * EXIT CODES
 *
 *   0  every check passed
 *   1  a check failed — the reason and the fix are printed
 *   2  the invocation itself was wrong (unknown flag, unparseable URL)
 *
 * THE TOKEN IS AN ENVIRONMENT VARIABLE AND NOT A FLAG, on purpose: a command line is
 * visible to every process on the machine and is kept in shell history, and this one
 * is a live session token.
 */

'use strict';

/** The deployed beta. A bare origin — no trailing slash, no path. */
const DEFAULT_API = 'https://superheng-api.onrender.com';
const DEFAULT_ORIGIN = 'https://superheng-3yf.pages.dev';

/**
 * How long one request may take before it is reported as unreachable.
 *
 * Deliberately generous rather than tight. The API runs on a free Render instance
 * that spins down after inactivity and can take the better part of a minute to wake,
 * so a short timeout would report a healthy service as down on the first run after a
 * quiet spell — the exact false alarm this script exists to avoid.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

const USAGE = `Usage: node scripts/smoke-test-paywall.js [options]

  --api=<origin>          API base URL (default ${DEFAULT_API})
  --origin=<origin>       the app's origin, for the CORS check (default ${DEFAULT_ORIGIN})
  --timeout=<ms>          per-request timeout (default ${DEFAULT_TIMEOUT_MS})
  --allow-unconfigured    treat the "not open yet" state as a pass
  --help                  this text

  SMOKE_TEST_TOKEN=<token>   also POST a real checkout session and assert it is payable
`;

/**
 * Parse the flags, rejecting anything unrecognised rather than ignoring it.
 *
 * A silently ignored typo would turn `--allow-unconfigured` into a stricter run than
 * the operator asked for, or `--api=` into a test of the wrong service — both of which
 * end in a confident, wrong answer.
 */
function parseArgs(argv) {
  const options = {
    api: (process.env.EXPO_PUBLIC_API_URL || DEFAULT_API).replace(/\/+$/, ''),
    origin: (process.env.EXPO_PUBLIC_APP_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, ''),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowUnconfigured: false,
    token: process.env.SMOKE_TEST_TOKEN || '',
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--allow-unconfigured') {
      options.allowUnconfigured = true;
    } else if (arg.startsWith('--api=')) {
      options.api = arg.slice('--api='.length).replace(/\/+$/, '');
    } else if (arg.startsWith('--origin=')) {
      options.origin = arg.slice('--origin='.length).replace(/\/+$/, '');
    } else if (arg.startsWith('--timeout=')) {
      const value = Number(arg.slice('--timeout='.length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new UsageError(`${arg} is not a positive number of milliseconds`);
      }
      options.timeoutMs = value;
    } else if (arg.startsWith('--token=')) {
      throw new UsageError(
        'the token must come from SMOKE_TEST_TOKEN: a command line is visible to other ' +
          'processes and kept in shell history'
      );
    } else {
      throw new UsageError(`unknown argument ${arg}`);
    }
  }

  for (const [label, value] of [
    ['--api', options.api],
    ['--origin', options.origin],
  ]) {
    if (!/^https?:\/\/[^\s/]+$/.test(value)) {
      throw new UsageError(
        `${label} must be a bare origin such as https://api.example.com — got ${JSON.stringify(value)}`
      );
    }
  }

  return options;
}

/** A problem with how the script was called, as opposed to a check that failed. */
class UsageError extends Error {}

/**
 * One request, bounded, with the status, headers and parsed body.
 *
 * A non-2xx is returned rather than thrown: several checks *want* an unexpected
 * status, and turning it into an exception would mean reading it out of a catch.
 */
async function request(url, { method = 'GET', headers = {}, body } = {}, timeoutMs) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    body: parsed,
    text,
    elapsedMs: Date.now() - startedAt,
  };
}

/** The outcome of one check, printed as it happens. */
function record(results, label, ok, detail, { skipped = false } = {}) {
  results.push({ label, ok, detail, skipped });
  const status = skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** The names a degraded server is missing, as `a, b, c`. */
function listMissing(body) {
  return Array.isArray(body.missing) && body.missing.length
    ? body.missing.join(', ')
    : 'an unnamed dependency';
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`smoke-test-paywall: ${error.message}\n`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  console.log(`Paywall smoke test — ${options.api} (app origin ${options.origin})`);
  const results = [];
  const { api, origin, timeoutMs, token } = options;

  // 1 — is anything there at all? This also warms a sleeping instance for the checks
  // below, which is why it runs first and gets the full timeout.
  let health;
  try {
    health = await request(`${api}/api/health`, {}, timeoutMs);
  } catch (error) {
    record(results, 'API reachable', false, `${describe(error)} (${api})`);
    return report(results);
  }
  record(
    results,
    'API reachable',
    health.status === 200,
    `${health.status} in ${health.elapsedMs}ms${health.body?.version ? `, version ${health.body.version}` : ''}`
  );
  if (health.status !== 200) {
    return report(results);
  }

  // 2 — the four dependencies a completed payment needs. This is the check that would
  // have caught the 403 that motivated the endpoint: a gateway with no named return
  // origin reports `degraded`, and `missing` names the variable to set.
  const diagnostics = await request(`${api}/api/diagnostics/paywall`, {}, timeoutMs);
  const checks = diagnostics.body?.checks ?? {};
  const status = diagnostics.body?.status;
  if (diagnostics.status !== 200 || typeof status !== 'string') {
    record(results, 'Diagnostics endpoint', false, `answered ${diagnostics.status}`);
  } else {
    // Two states pass, and for opposite reasons. `not_configured` is the honest "not
    // open yet" state, which is only acceptable when the operator says so — the
    // default run is aimed at a deployment that is supposed to be selling. `degraded`
    // never passes: something is configured and something else is missing, which is
    // the one combination that can take money it cannot account for.
    const acceptable =
      status === 'ok' || (status === 'not_configured' && options.allowUnconfigured);
    const detail =
      status === 'ok'
        ? 'ok'
        : status === 'degraded'
          ? `degraded — missing ${listMissing(diagnostics.body)}`
          : options.allowUnconfigured
            ? 'not configured, which --allow-unconfigured accepts'
            : 'nothing is configured, so this deployment cannot sell — set the Stripe and ' +
              'Supabase variables, or pass --allow-unconfigured if it is not meant to sell yet';

    record(results, 'Paywall diagnostics', acceptable, detail);

    // Printed even when healthy: this is what a run is read for months later, when
    // "it passed last week" is the question being asked.
    console.log(
      `         gateway=${flag(checks.gateway_configured)} webhook=${flag(checks.webhook_configured)}` +
        ` writer=${flag(checks.entitlement_writer_configured)}` +
        ` return_origin=${flag(checks.return_origin_configured)}` +
        ` cors_named=${flag(checks.cors_configured)}`
    );

    // The server's own sentences name the variable and where to set it, which is more
    // specific than anything this script could invent.
    if (status !== 'ok') {
      for (const sentence of diagnostics.body.details ?? []) {
        console.log(`         ${sentence}`);
      }
    }
  }

  // 3 — CORS, as the browser will actually ask for it. A preflight is the browser's
  // own question, so this is the check that answers "would the real app be allowed to
  // call this", which a plain GET with an Origin header does not.
  try {
    const preflight = await request(
      `${api}/api/create-checkout-session`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      },
      timeoutMs
    );
    const allowed = preflight.headers.get('access-control-allow-origin');
    const allowedHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    const originOk = allowed === '*' || allowed === origin;
    const authOk = allowedHeaders === '*' || allowedHeaders.includes('authorization');
    record(
      results,
      `CORS preflight for POST /api/create-checkout-session from ${origin}`,
      preflight.status < 400 && originOk && authOk,
      `allow-origin=${allowed ?? '(absent)'}, allow-headers=${allowedHeaders || '(absent)'}`
    );
  } catch (error) {
    record(results, 'CORS preflight', false, describe(error));
  }

  // 4 — the route's own origin validation, which needs a token because the route
  // authenticates first. See the header: use this against a test-mode deployment.
  if (!token) {
    record(
      results,
      'Checkout route accepts this origin',
      true,
      'skipped — set SMOKE_TEST_TOKEN to include it',
      { skipped: true }
    );
  } else {
    try {
      const session = await request(
        `${api}/api/create-checkout-session`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Origin: origin,
          },
          body: JSON.stringify({
            plan: 'premium_monthly',
            idempotency_key: `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
            return_origin: origin,
          }),
        },
        timeoutMs
      );
      const body = session.body ?? {};
      const url = typeof body.checkout_url === 'string' ? body.checkout_url : '';
      const paid = body.charged === true || body.subscription_granted === true;
      record(
        results,
        'Checkout route opens a payable session',
        session.status === 200 && /^https:\/\//.test(url) && !paid,
        session.status === 200
          ? `${url ? `checkout_url host ${new URL(url).host}` : 'no checkout_url'}${body.live_mode === true ? ', LIVE MODE' : ''}`
          : `${session.status}${session.body?.detail ? ` — ${session.body.detail}` : ''}`
      );
      if (paid) {
        record(results, 'The session took no money', false, 'the response claimed a charge');
      } else {
        record(results, 'The session took no money', true, 'charged=false, subscription_granted=false');
      }
    } catch (error) {
      record(results, 'Checkout route opens a payable session', false, describe(error));
    }
  }

  return report(results);
}

/** `true`, `false`, or `?` for a missing field — an absent check is not a `false`. */
function flag(value) {
  return value === true ? 'yes' : value === false ? 'NO' : '?';
}

/** A one-line reason for a thrown fetch failure. */
function describe(error) {
  if (error?.name === 'TimeoutError') return 'timed out';
  return error?.message ?? String(error);
}

/** Print the tally and return the exit code. */
function report(results) {
  const failed = results.filter((result) => !result.ok && !result.skipped);
  const skipped = results.filter((result) => result.skipped);
  const passed = results.filter((result) => result.ok && !result.skipped);

  console.log(
    `\n${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed`
  );
  if (failed.length) {
    console.error(`\nFAILED: ${failed.map((result) => result.label).join('; ')}`);
    return 1;
  }
  console.log('Paywall looks healthy.');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    // An unexpected throw is still a failed run, and the stack is the useful part.
    console.error(`smoke-test-paywall: ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
);
