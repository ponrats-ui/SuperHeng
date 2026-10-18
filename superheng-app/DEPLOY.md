# Deploying SuperHeng (Cloudflare Pages + Render)

Production deploy guide for the beta. Two pieces ship separately:

| Piece | Platform | Source | Build | Serves |
|---|---|---|---|---|
| Web frontend | **Cloudflare Pages** | `superheng-app/` | `npm run build` → `dist/` | `https://superheng-3yf.pages.dev` |
| Prediction API | **Render** (Web Service) | `superheng-app/backend/` | `pip install -r requirements.txt` | `https://superheng-api.onrender.com` |
| Database | **Supabase** (existing) | — | — | hosted Postgres, already provisioned |

Config files this guide relies on, already in the repo:

- [`render.yaml`](../render.yaml) — Blueprint for the API, at the **repository root**.
- [`wrangler.toml`](wrangler.toml) — Pages project config, in the **app root**.
- [`backend/.env.example`](backend/.env.example), [`.env.example`](.env.example) — variable names, no secrets.

> **Repo layout warning.** The repository root also contains a *superseded baseline
> copy* of the app (`backend/`, `src/`, `app.json` at the top level). It is not
> what you want to deploy. Every path below points into `superheng-app/`.

---

## Why the order below matters

Two values are fixed at different times, and each depends on the other:

1. The frontend bakes its API URL into the bundle at **build time**, not runtime
   (Expo inlines every `EXPO_PUBLIC_*` value). So the backend URL must exist before
   the frontend is built.
2. The backend only accepts the browser origin it is told to accept, so
   `CORS_ORIGINS` needs the Pages hostname.

Both are predictable from the names in `render.yaml` and `wrangler.toml`, so the
defaults in those files already line up. The steps below just keep them that way.
Deploy the backend first; the frontend needs something to point at.

---

## Step 0 — Push the current code to GitHub

```bash
git checkout -b main            # if you are not already on it
git add render.yaml superheng-app/wrangler.toml superheng-app/package.json \
        superheng-app/backend/main.py superheng-app/.env.example \
        superheng-app/backend/.env.example superheng-app/DEPLOY.md
git commit -m "Add Render + Cloudflare Pages deployment configuration"
git push origin main
```

Never commit `backend/.env` — it holds the Supabase key. Both `.env` files are
already git-ignored, and `dist/` is too, so build output stays out of Git.

---

## Step 1 — Backend on Render

### Fast path: the Blueprint

1. Sign in at <https://dashboard.render.com> with the GitHub account that can see
   `ponrats-ui/SuperHeng`.
2. **New → Blueprint**.
3. Pick the `SuperHeng` repository and the `main` branch.
   Leave **Blueprint Path** as `render.yaml` — it is at the repo root, which is
   where Render looks by default.
4. Render shows one service, `superheng-api`, and asks for the two variables
   marked `sync: false` in the Blueprint. Fill them in from
   **Supabase → Project Settings → Data API / API Keys**:
   - `SUPABASE_URL` — the **bare** project URL, `https://<project-ref>.supabase.co`.
     The Data API page displays it with `/rest/v1` on the end; do not paste that
     path. The client appends `/rest/v1` itself, so the suffix produces
     `/rest/v1/rest/v1/lottery_draws`, a 404 from PostgREST and `PGRST125` from
     every query — while `/api/health` still reports `"configured"`. Strip any
     trailing slash or newline that comes with a copy-paste too.
   - `SUPABASE_KEY` — the **anon** key is enough. The API only reads draws, and
     the schema's RLS policy allows exactly that. Do not paste the
     `service_role` key: it bypasses RLS and is only needed by the ingestion
     script, which runs locally.
5. **Apply**. The first build takes a couple of minutes; every package resolves
   to a prebuilt `manylinux` wheel, so nothing is compiled from source.
6. Confirm it is live:

```bash
curl -s https://superheng-api.onrender.com/api/health
```

Expect HTTP 200 and `"supabase": "configured"`.

### The database migration must run before the multi-country API is deployed

The API now filters every draw query by `lottery_type`, and the preset Thai ledger
(Premium Insights) exposes a `?type=thai|laos|vietnam` parameter. That column and
the composite key only exist once **`backend/schema.sql` has been applied**
(Supabase → SQL Editor → paste the file → **Run**; it is idempotent, so re-running
is safe and it backfills existing rows as `'thai'`).

Run it **before** deploying or restarting the API. Without it every prediction
endpoint — not just Premium — answers `500` with
`column lottery_draws.lottery_type does not exist` (`42703`), because
`fetch_draw_history` filters on the column for all of them:

```bash
# Must return the positional payload, not a 500.
curl -s "https://superheng-api.onrender.com/api/predict/premium?type=thai" | head -c 200
```

The migration is additive: it adds a column with a default, drops the old
`draw_date` unique constraint and replaces it with a unique index on
`(lottery_type, draw_date)`. `backend/scraper.py`'s `CONFLICT_TARGET` already
matches the new index, so Thai ingestion keeps working across the change.

It also **widens `first_prize` from exactly 6 digits to 5 or 6**, because
Vietnam's giải đặc biệt is a five-digit number and is stored as one: padding it to
six would put a permanent `0` at the leading position, which the premium model
would publish as a position with a 100% posterior. Thai and Lao rows are unaffected
— 6 digits is still valid — but a ledger that still carries the old
`lottery_draws_first_prize_is_6_digits` constraint will reject every Vietnamese row
with `23514`, so apply the file before running the Vietnamese ingestion.

### Ingestion now covers three ledgers, from one workflow

`.github/workflows/auto_scraper.yml` runs one job per ledger, each on its own
schedule and each gated on which cron entry fired:

| Ledger | Script | Schedule |
| --- | --- | --- |
| `thai` | `backend/scraper.py` | 1st, 2nd, 16th, 17th at 10:30 UTC |
| `vietnam` | `backend/scripts/scrape_international.py --type vietnam` | daily at 12:15 UTC |
| `laos` | `backend/scripts/scrape_international.py --type laos` | Mon-Fri at 14:30 UTC |

Every path in that file is `superheng-app/backend/...`, which is the directory
Render deploys (`rootDir` in `render.yaml`). The same workflow also exists at
`superheng-app/.github/workflows/auto_scraper.yml`, where it never runs: GitHub
reads workflows only from the repository-root `.github/`.

Each job then reads its own ledger back with
`backend/verify_ingestion.py --type <ledger>` and fails the run if the write did
not land — a green scrape only proves the rows were *sent*.

The routine window is the last 14 draw dates, because both international sources
are addressed one date at a time. Backfilling history is a deliberate run:

```bash
python backend/scripts/scrape_international.py --dry-run --days 30
python backend/scripts/scrape_international.py --type vietnam --from 2025-10-01
```

Run `--dry-run` first when a source changes: it fetches, validates and prints the
rows without writing, which is how both parsers were verified against the live
sites on 2026-10-14.

**That 200 does not mean the credentials work.** `/api/health` always answers 200
and reports only whether the two variables are *present*; it never queries the
database. Render uses this same endpoint as its health check, so a service whose
credentials are wrong still deploys green and then returns `500` on every data
endpoint — which is exactly what the first deploy of this service did. Prove the
credential pair with a query instead:

```bash
curl -s "https://superheng-api.onrender.com/api/latest-draws?limit=1"
```

A JSON array of draws means the database is genuinely reachable. A `500` carrying
`PGRST125` ("Invalid path specified in request URL") means `SUPABASE_URL` was
pasted with a path on the end — see the `SUPABASE_URL` note in step 4 above.

### Same thing by hand (no Blueprint)

Create a **Web Service** from the repo, then:

| Field | Value |
|---|---|
| Runtime | Python 3 |
| Root Directory | `superheng-app/backend` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/api/health` |
| Instance Type | Free (see the caveat below) |

Environment variables: `PYTHON_VERSION=3.14.3`, `PYTHONUNBUFFERED=1`,
`CORS_ORIGINS=https://superheng-3yf.pages.dev`,
`CORS_ORIGIN_REGEX=^https://([a-z0-9-]+\.)?superheng-3yf\.pages\.dev$`,
plus the two Supabase values.

Two things that are easy to get wrong:

- **`$PORT` must stay in the start command.** Render assigns a port per instance
  and routes to it; a hardcoded `8000` is not reachable from the internet.
- **Do not add `--reload`.** The app's offline hint suggests
  `uvicorn main:app --reload` for local development. On Render the reloader
  watches files in a container that will never change, spending startup time and
  memory for nothing.

### Note for beta testers: free instances sleep

A free Render web service spins down after **15 minutes** with no traffic and
takes roughly a **minute** to wake on the next request, so the first visit after
a quiet spell is a very slow load.

The frontend is built for that. `src/lib/api.ts` retries a hung or
`502`-answering request with rising backoff for up to `WAKE_DEADLINE_MS` (75s),
so a single 10s abort can no longer misreport a healthy-but-sleeping service as
dead. While that happens the header badge reads **CONNECTING**, then **WAKING**
once retries begin — never **OFFLINE**, which is now reserved for a request that
actually failed after the whole budget. That distinction is what keeps a beta
tester from seeing "OFFLINE" over a backend that is merely booting.

If even that wait is unacceptable during the beta, switch the service to a paid
**Starter** instance in the dashboard (or in `render.yaml`, then re-apply) — the
instance always stays warm.

---

## Step 2 — Frontend on Cloudflare Pages

1. Sign in at <https://dash.cloudflare.com> → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git**.
2. Authorise GitHub and select the `SuperHeng` repository.
3. Set the build configuration:

| Field | Value | Why |
|---|---|---|
| Production branch | `main` | Every push to it becomes a production deploy |
| Framework preset | **None** | Expo is not a listed preset; choosing one injects the wrong build command |
| Build command | `npm run build` | Runs `expo export -p web` from `package.json` |
| Build output directory | `dist` | What `expo export` writes |
| **Root directory** | `superheng-app` | The app is a subdirectory of the repo |

**Root directory is the field that matters most.** With it set, the build starts
inside `superheng-app`, so `package-lock.json` is found (`npm ci`) and the output
directory is `dist` — **not** `superheng-app/dist`. Setting the root directory but
writing a repo-relative output path is the classic monorepo mistake; it fails with
"output directory not found".

4. **Build-time variables live in `wrangler.toml`, not in the dashboard.**

   With a `wrangler.toml` in the build root, Cloudflare takes the Pages build
   configuration from that file, and the build environment is populated from its
   `[vars]` table. The build log states what it found, in as many words:

   ```
   Found wrangler.toml file. Reading build configuration...
   pages_build_output_dir: dist
   Build environment variables: (none found)
   ```

   So `EXPO_PUBLIC_API_URL` is declared in [`wrangler.toml`](wrangler.toml), and
   that is what reaches `npm run build`:

   ```toml
   [vars]
   EXPO_PUBLIC_API_URL = "https://superheng-api.onrender.com"
   ```

   **Do not rely on a dashboard variable for this.** An entry added under
   Settings → Variables and secrets is of type Text or Secret, which is a
   *runtime* variable, and it does not reach the build. Measured on this project:
   two production builds exported a bundle containing the `http://127.0.0.1:8000`
   fallback from `src/lib/api.ts` and no trace of the Render URL, while the
   dashboard entry was present and correct the whole time. `EXPO_PUBLIC_*` is
   inlined at build time, so the value has to be readable *by the build* — and
   declaring it here also keeps it under review instead of hidden in a dashboard.

   It is a public endpoint that ends up in client JavaScript either way, which is
   exactly why no secret belongs in this table.

   **Rebuild with `--clear` after changing it.** `expo export` reuses Metro's
   transform cache, and the inlined `EXPO_PUBLIC_*` value is part of what is
   cached. Measured here: a second `expo export -p web` run with a different
   `EXPO_PUBLIC_API_URL` shipped a bundle that still contained the *previous*
   build's value, so the verified page called a host that no longer existed and
   the dashboard showed its offline state. `npx expo export -p web --clear`
   rebuilds it correctly. The Pages build never hits this — it starts from a fresh
   checkout — but a local export used for verification will silently lie about
   which API it is talking to.

   `NODE_VERSION` is the one variable that stays in the dashboard, because it
   selects the build image rather than being read by the build command. This
   project's build ran on `nodejs@22.16.0`, which is also the Pages default, so it
   is a pin rather than a change. Metro requires
   `^20.19.4 || ^22.13.0 || ^24.3.0 || >= 25.0.0`. Deliberately set *only* this
   one — Pages also honours `.nvmrc` and `.node-version`, and the docs do not
   state which wins, so mixing methods is how environments drift.

5. **Save and Deploy**. The site lands at `https://superheng-3yf.pages.dev`.

   The **project name** is `superheng` — that is what `name` in
   [`wrangler.toml`](wrangler.toml) must match, and what `--project-name` takes.
   The **hostname** is not the project name: `<project-name>.pages.dev` is
   claimed globally, and `superheng.pages.dev` was already taken, so Cloudflare
   appended a `-3yf` suffix. Preview builds live at
   `<hash>.superheng-3yf.pages.dev`. Use the `-3yf` host everywhere below —
   `CORS_ORIGINS` in Step 3 above all.

If you rename the Pages project, update **both** `name` in
[`wrangler.toml`](wrangler.toml) **and** `CORS_ORIGINS` on Render, or the
frontend's requests will be blocked by CORS.

### Publishing from the CLI instead

Useful for a one-off deploy, or if you would rather not connect the repo:

```bash
cd superheng-app
npm ci
EXPO_PUBLIC_API_URL=https://superheng-api.onrender.com npm run build
npx wrangler login
npx wrangler pages deploy dist --project-name superheng            # production
npx wrangler pages deploy dist --project-name superheng --branch my-test-branch   # preview
```

The branch name decides production vs preview — there is no separate flag.
`npx wrangler pages deploy` uploads `dist` exactly as it is; it does not run a
build for you.

---

## Step 3 — CORS in the beta (and how to tighten it before launch)

**The beta ships deliberately open.** `render.yaml` sets:

```
CORS_ORIGINS=*
CORS_ALLOW_CREDENTIALS=true
```

Every origin is accepted — the Pages production alias, any preview hash, a
custom domain added later, and the Expo dev server. Nothing about the beta
depends on getting CORS right, and nothing needs redeploying when the Pages
hostname changes. Confirm it from your own machine:

```bash
curl -s -D - -o /dev/null -H "Origin: https://anything.example.com" \
  https://superheng-api.onrender.com/api/health | grep -i access-control
```

```
access-control-allow-origin: https://anything.example.com
access-control-allow-credentials: true
```

**What `CORS_ALLOW_CREDENTIALS=true` really does — measured, not assumed.** The
usual advice is that `*` plus credentials is invalid and browsers reject it.
That rule is about the `Access-Control-Allow-Origin: *` *header*, and Starlette
does not send that header once credentials are on: it reflects the caller's
origin instead. So the combination works rather than breaking — verified in a
browser sending `credentials: 'include'` against this exact configuration
(HTTP 200, no console error).

Understand the trade, though: with a wildcard allow-list *and* credentials,
**every** origin is reflected **and** told it may send credentials. That is
inert for this API today, because it authenticates with a request header (the
planned `X-API-Key`) and not a cookie — there is nothing for a browser to
attach. It is exactly the switch to remove before any cookie-based session
exists, or any site will be able to act as a logged-in user.

### Before launch

Replace the two beta variables in **Render → superheng-api → Environment** with:

```
CORS_ORIGINS=https://superheng-3yf.pages.dev
CORS_ORIGIN_REGEX=^https://([a-z0-9-]+\.)?superheng-3yf\.pages\.dev$
```

and delete `CORS_ALLOW_CREDENTIALS`.

- `CORS_ORIGINS` is a comma-separated list of **origins** — scheme, host, port,
  no trailing slash, no path. Add a custom domain here too when you attach one,
  e.g. `https://superheng-3yf.pages.dev,https://app.superheng.app`.
- `CORS_ORIGIN_REGEX` is what keeps **preview deployments** working. Every Pages
  preview build gets a fresh `<hash>.<project>.pages.dev` host, so the pattern
  authorises all of them at once and a PR preview never needs an API change.
- With the allow-list in place an unlisted origin receives **no**
  `access-control-allow-origin` header at all, which is how you check it:

```bash
curl -s -D - -o /dev/null -H "Origin: https://elsewhere.example.com" \
  https://superheng-api.onrender.com/api/health | grep -i access-control-allow-origin
```

No output means the origin was refused. Read the headers rather than the status
code — CORS is enforced by browsers only, so `curl` gets a 200 either way.

Saving an environment variable restarts the service; no code change and no
redeploy is needed. Leaving all three unset keeps the permissive development
default (`*`), which is what local Expo builds rely on.

---

## Step 4 — Verify the deployed pair

1. Open `https://superheng-3yf.pages.dev` in a browser and open DevTools → Console.
   - **No CORS or "mixed content" errors.** All requests must be `https://`.
   - The header shows a live state, not the red `OFFLINE` badge.
   - "Draws analysed" and "Latest draw" are populated rather than `—`.
2. Click through Dashboard, My Number, Insights, Performance. Each is a separate
   static HTML file on Pages, so a blank tab usually means a missing route:
   `curl -s -o /dev/null -w '%{http_code}\n' https://superheng-3yf.pages.dev/insights`
   should print `200`.
3. Confirm the bundle the site actually serves. A `200` from `/` proves nothing
   about this, because the failure mode is a *successful* build with the wrong
   value baked in. The first check catches a missing `[vars]` entry; the second
   catches Pages silently dropping an asset (Step 2, and the `node_modules`
   limitation below):

```bash
JS=$(curl -s https://superheng-3yf.pages.dev/ | grep -oE '/_expo/static/js/web/[^"]+\.js' | head -1)

# >= 1: the build inlined the Render URL. 0 means [vars] was not read.
curl -s "https://superheng-3yf.pages.dev$JS" | grep -c 'superheng-api\.onrender\.com'

# font/ttf: the asset was uploaded. text/html means the SPA fallback answered
# instead, i.e. Pages refused to upload it and the icons render as blank squares.
curl -s -o /dev/null -w '%{content_type}\n' \
  "https://superheng-3yf.pages.dev/assets/vendor/@expo-google-fonts/material-symbols/400Regular/MaterialSymbols_400Regular.a1525894e1eb1edaa185654fe42c3f1a.ttf"
```

4. Open a pull request to confirm previews work: Cloudflare comments the preview
   URL, and the API accepts it via `CORS_ORIGIN_REGEX`.
5. Run the API's non-browser path too — this proves the backend, independent of
   CORS (browsers enforce CORS; `curl` does not):

```bash
curl -s "https://superheng-api.onrender.com/api/predict/basic?limit=100" | head -c 400
```

---

## Step 5 — Shipping updates later

- **Backend:** push to `main`. Render redeploys automatically
  (`autoDeployTrigger: commit`).
- **Frontend:** push to `main`. Cloudflare rebuilds and republishes.
- **Changing the API URL or any `EXPO_PUBLIC_*` variable:** edit `[vars]` in
  [`wrangler.toml`](wrangler.toml) and push. The edit is what inlines the new value
  into the bundle and the push is what makes Pages build it. Editing a dashboard
  variable will not do it (see Step 2).

---

## Step 6 — Accounts and the premium subscription

This is what turns the premium panel from a client-side password into something
that can be sold. It has to be done **after** the backend and frontend are
deployed, because it adds a requirement to an endpoint the old frontend does not
satisfy (see the ordering warning at the end of this section).

### 6.1 Create the entitlement schema

Supabase dashboard → SQL Editor → paste **`backend/schema_profiles.sql`** → Run.
It is idempotent, so running it twice (or running a fixed version later) changes
nothing.

It creates `public.user_profiles` (one row per account, keyed to `auth.users`),
enables row-level security, and grants a signed-in user exactly two things: read
their own row, and change their own `display_name`. `subscription_tier`,
`subscription_expiry` and `subscription_provider` are **not** writable by any
client, by design — an RLS policy chooses a row, only a column-level grant chooses
a column, and both are needed to actually stop someone from setting their own tier
to `premium` with a PATCH.

It also installs three triggers: one that creates the profile row on signup, one
that keeps the copied email address in step, and one that maintains `updated_at`.
It backfills a row for every account that already exists.

It also creates the **payment ledger** and the one function that grants an
entitlement: `public.payment_events` and `public.apply_payment_event(...)`. Those
are not used until Step 6.5, and they are safe to apply early.

The file's last section is a set of verification queries — including the two
curl-shaped checks that must be **refused**, and the two that check the payment
ledger's fences — which are the ones worth actually running before taking money.

### 6.2 Point the frontend at the project

Add two variables to [`wrangler.toml`](wrangler.toml) → `[vars]`, and to
`superheng-app/.env` for local development:

```
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<the publishable / anon key>
```

**`[vars]`, not the dashboard.** This step previously said "Pages → Settings →
Environment variables", and that advice does not work: with a `wrangler.toml` in
the build root Cloudflare reads the Pages build configuration from it, and a
variable added in the dashboard is a *runtime* variable that `npm run build`
never sees. Measured, not assumed — the production bundle shipped with no
Supabase values at all and the Premium panel answered "not configured" to every
visitor, while the same two values worked in every local build. `wrangler.toml`
now carries them, next to `EXPO_PUBLIC_API_URL`, with the reasoning in a comment.

`EXPO_PUBLIC_*` is inlined at **build** time — changing these does nothing until
the next build — and they are readable in the shipped bundle.
That is correct here: the publishable key is meant to be public and row-level
security is what protects the data. **Never** put the `service_role` key in either
place; it bypasses RLS and belongs only in `backend/.env` for ingestion.

Nothing new is needed in the backend to *read* an entitlement, and that is
deliberate: it validates tokens with Supabase Auth and reads the profile **using
the caller's own token**, so it holds no privileged credential at all for that part.
`SUPABASE_KEY` in `backend/.env` must be the **anon** key for that to hold — a
`service_role` key there would still work, but it would also succeed for any user
id, which is exactly the protection being bought.

The one exception is *writing* an entitlement, which happens only in the payment
webhook and needs its own credential — `SUPABASE_SERVICE_KEY`, added in Step 6.5.
Keeping the two separate is the point: the read path stays RLS-bound, and the single
write path is the one place that holds a key which bypasses it.

### 6.3 Supabase Auth settings worth deciding now

* **Confirm email.** With it on (the default), `signUp` returns no session and the
  user must click a link before signing in. On **web** that works — the app reads
the session from the redirect URL. On **native** it does *not*: the link opens a
  browser, not the app, so confirmation cannot complete without deep linking
  (`expo-linking`, a `superheng://` scheme, and `exchangeCodeForSession`). Until
  that exists, either leave confirmation off or expect native signups not to finish.
* **Redirect URLs.** Add the production origin (`https://<project>.pages.dev`) and
  `http://localhost:8081` under Authentication → URL Configuration, or the
  confirmation link will bounce.
* **Minimum password length** defaults to 6; the app checks the same number so the
  error is instant rather than a round trip. Changing one without the other makes
  the client's message wrong.

### 6.4 Making an account premium by hand

Before Step 6.5 is done — and afterwards too, for a comped account or a support
fix — entitlements are granted from the SQL editor (which connects with privileges
that bypass RLS):

```sql
update public.user_profiles
   set subscription_tier     = 'premium',
       subscription_expiry   = now() + interval '1 year',
       subscription_provider = 'manual'
 where email = 'you@example.com';
```

To revoke, set the tier back to `'free'` — do not delete the row, or the next
sign-in has no profile to read and is refused.

### 6.5 Turn on payments (Stripe, card + PromptPay)

Cards for international customers, PromptPay for Thai ones. Both go through
Stripe's **hosted** Checkout page, so no Stripe code and no publishable key ever
ships in the app — see [`../.env.example`](../.env.example) for why the
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` from the original brief is deliberately absent
rather than merely unset.

**Until both secrets in step 3 are set, the app stays in its "coming soon" state,
and that is not a placeholder.** `GET /api/checkout/plans` reports `live: false`, the
paywall hides the payment-method block and its button says "Subscribe", and
`POST /api/checkout/create-session` answers with the honest "nothing was charged"
shape. A secret key *without* a webhook secret counts as **not configured**, on
purpose: it would create real, payable sessions that could never grant access — the
customer pays and nothing happens.

#### 1. Set up the Stripe side

1. **Enable PromptPay** — Dashboard → Settings → Payment methods → PromptPay.
   Stripe documents it as **THB-only and for Thailand-registered accounts**. If the
   account is not Thai, skip this and set `STRIPE_PAYMENT_METHODS=card` (step 3) —
   otherwise the offer simply does not appear, which is a filter rather than an
   error. The reasoning is in the `payment_method_types` note at the top of
   `backend/payments.py`.
2. **Nothing else.** There is no product or price to create: the session is built
   from this server's own catalogue in `backend/checkout.py`, line items included,
   so the price the app shows and the price Stripe charges have exactly one source
   and cannot drift apart.

#### 2. Register the webhook endpoint

Dashboard → Developers → Webhooks → Add endpoint.

```
URL    : https://superheng-api.onrender.com/api/webhook/stripe
Events : checkout.session.completed
         checkout.session.async_payment_succeeded
         checkout.session.async_payment_failed
         checkout.session.expired
```

`https://superheng-api.onrender.com/api/webhook` is the same handler under a
shorter name, so a dashboard endpoint already pointing at either spelling works.
The signing secret is per endpoint: if you add a second endpoint, copy *its* secret
into `STRIPE_WEBHOOK_SECRET` rather than assuming the two share one.

The `async_payment_*` events are not decoration. A session can complete while its
payment is still settling, so the grant waits for the event that means the money
actually arrived; without those two subscriptions a delayed payment would be
recorded for the ledger and never granted.

Copy the endpoint's **signing secret** (`whsec_…`). Each endpoint has its own, and
`stripe listen` prints a *different* one — pasting the wrong one makes every
delivery fail verification with a 400 that is indistinguishable from an attack in
the logs.

#### 3. Set the environment variables

Render → Environment:

```
STRIPE_SECRET_KEY=sk_live_…            # or sk_test_… while testing
STRIPE_WEBHOOK_SECRET=whsec_…          # from the endpoint in step 2
SUPABASE_SERVICE_KEY=…                 # service_role / sb_secret_…, NOT the anon key
FRONTEND_BASE_URL=https://superheng-3yf.pages.dev
```

`SUPABASE_SERVICE_KEY` is the one genuinely new credential. Everywhere else the API
reads `user_profiles` with the **caller's own** token, and that is the whole design
— but a column-level grant deliberately refuses `subscription_tier` to
`authenticated`, so the one function that writes an entitlement needs a key that
bypasses RLS. It is a full-access admin credential for the project: server-side
only, never `EXPO_PUBLIC_`, never in the app, never committed. It is read in exactly
one place, `backend/webhook.py`.

`FRONTEND_BASE_URL` is where Stripe sends the customer back after paying. Without
it the fallback is the first non-wildcard `CORS_ORIGINS` entry, and failing that
`http://localhost:8081`. A payment still succeeds and is still granted without it —
the webhook does not depend on the redirect — but the customer would land on a dead
page immediately after paying, which is a bad way to end a purchase.

Optional: `STRIPE_PAYMENT_METHODS` (`card,promptpay` by default; use `card` on a
non-Thai account, or `dynamic` to let Stripe choose its own set), `STRIPE_API_VERSION`
to pin the API version, `STRIPE_TIMEOUT_SECONDS` to change the 10-second call budget.

#### 4. Re-apply the schema

Run **`backend/schema_profiles.sql`** again (SQL Editor → paste → Run). It is
idempotent, and this run adds:

* **`public.payment_events`** — the payment ledger. `id` is Stripe's event id and is
  part of the primary key, which **is** the idempotency mechanism: Stripe retries a
  failed delivery for up to three days and can deliver the same event twice even
  when nothing failed, and a retried "payment succeeded" must not extend a
  subscription twice. It is `on delete set null`, **not** a cascade — deleting an
  account must not delete the record that money was taken, because the refund
  dispute and the revenue report both arrive afterwards.
* **`public.apply_payment_event(...)`** — the only code anywhere that writes
  `subscription_tier`. It claims the event and extends the subscription inside one
  transaction, so two concurrent deliveries cannot both grant. A renewal extends
  from the later of now and the current expiry, so buying again never discards time
  already paid for.

**Run verification query 6 in that file before going live.** PostgreSQL grants
`EXECUTE` to `PUBLIC` on a newly created function and PostgREST exposes every
function in the schema it serves, so a missing `REVOKE` would be a
grant-yourself-premium endpoint reachable with the app's *public* anon key. The file
revokes it from `public, anon, authenticated` and grants it to `service_role` only;
query 6 is the check that it worked, and query 7 proves the retry is a no-op.

#### 5. Verify with a real payment — in test mode

`sk_test_…` plus Stripe's test cards exercise the whole path without moving money.
Card `4242 4242 4242 4242`, any future expiry, any CVC. In test mode PromptPay
generates a QR you scan with Stripe's own test page.

Then check these in order. Each catches a different failure:

1. `GET /api/health` → `checkout.gateway_configured: true`, `provider: "stripe"`,
   `entitlement_writer: "configured"`. If the last one says `not_configured`,
   `SUPABASE_SERVICE_KEY` is missing and every payment would be taken and dropped.
2. Tap **Upgrade** while signed out → the app asks you to sign in first.
3. Sign in and tap it → you leave for `checkout.stripe.com`. The app must **not**
   claim anything has been paid at this point, because nothing has.
4. Pay → you return to `/premium`, which re-asks the server for a few seconds
   ("Stripe is confirming your payment") and then shows the account as premium.
5. Open the webhook endpoint's **Events** in the Stripe dashboard: the delivery
   should be `200`. A `400` means the signing secret does not match that endpoint. A
   `503` means the database step failed, and the response body says which variable
   or which file to apply.
6. **Re-send the same event** from the dashboard. The response must say `duplicate`
   and the expiry must not move. That is the idempotency check, and it is the one
   worth doing before launch.
7. Refund the test payment and confirm the account keeps access until its expiry.
   There is deliberately no automatic revocation on refund — losing access the
   instant a refund is issued is a product decision, and it should be made
   explicitly rather than as a side effect.

#### The invariant this feature is built around

`POST /api/checkout/create-session` **never** charges and **never** grants, with a
gateway configured or without one: it returns `charged: false` and
`subscription_granted: false` every time. Premium is written in exactly one place —
`backend/webhook.py`, from a request whose Stripe signature verified — and the
database enforces the same rule from the other side. Two answers to "is this account
premium" therefore cannot disagree, because there is only one writer.

Still unverified end to end: **native iOS/Android rendering** of the upgrade flow.
The redirect helper in `src/lib/checkout.ts` hands the URL to the system browser on
native, which is the branch that has not been exercised on a device.

### ⚠️ Deploy ordering: the backend gate breaks the *old* frontend

`/api/predict/premium` now answers `401` without a bearer token. Any deployed
frontend built **before** this change sends no token, so its premium panel will
report a failure instead of showing the password form it used to. That is intended
— the old form never protected anything — but it means **deploy the new frontend
and the new backend together.** Backend first is safe only in the sense that the
free dashboard, the ledger and the backtest keep working throughout; the premium
panel is down until the matching frontend build is live.

The same applies to the free tier, so it is worth stating: `/`, `/api/health`,
`/api/latest-draws`, `/api/predict/basic`, `/api/predict/advanced`, `/api/backtest`
and `/api/checkout/plans` remain public and unaffected.

## Rollback

- **Render:** the service's **Events** list keeps every deploy; "Redeploy" an
  earlier one. Or `git revert` and push.
- **Cloudflare Pages:** **Deployments → ⋯ → Rollback to this deployment** returns
  production to a previous build instantly, without a rebuild.

---

## Known limitations

- **The API is unauthenticated.** CORS does not protect it — it is a browser
  policy, and `curl`, bots and the native app ignore it. Anyone who learns the
  URL can call every endpoint and consume the free instance's capacity. Fine for
  a closed beta; an `X-API-Key` check (plus rate limiting) is the next step
  before the URL is publicised. The two exceptions are deliberate and stronger
  than a password: `/api/predict/premium` requires a bearer token whose account
  holds the entitlement, and `POST /api/webhook/stripe` cannot take a token at
  all — Stripe is a server — so it is authenticated by an HMAC signature over the
  raw request body, which is the only thing standing in front of the one function
  that writes `subscription_tier`.
- **CORS is wide open on purpose and `CORS_ALLOW_CREDENTIALS=true`** (see
  Step 3). Both are beta-only and must be reverted before launch, and before any
  cookie-based login is introduced.
- **Free Render instances sleep** (see Step 1). Expect a ~1 minute cold start
  after 15 idle minutes. The client waits it out instead of reporting an offline
  backend, and which retry it uses depends on how the cold start presents: a hung
  attempt retries on a rising backoff for up to 75s, while a *network* failure —
  the usual case, because Render's 502 error page carries no CORS headers and the
  browser therefore blocks it before any status can be read — retries every 5s for
  up to a minute. Both show as "WAKING".

  Preferred fix is to stop it sleeping: point an uptime monitor at `GET /health`
  every 10 minutes. Use `/health` and not `/api/health` — the latter reports
  dependency state rather than liveness, and a monitor that alarms on a degraded
  dependency is an alarm for a condition the service is built to survive.
- **Supabase connection pooling.** Each Render instance opens its own
  connections. One instance is harmless; scaling the service up needs the pooler
  endpoint (`...pooler.supabase.com`) rather than direct connections.
- **Pages refuses to upload anything under a `node_modules` path.** Expo mirrors
  asset source paths into `dist/assets/`, so the icon font and expo-router's
  navigation icons are emitted at `dist/assets/node_modules/...`. Cloudflare
  excludes those — "Pages would automatically exclude some files and folders from
  being uploaded as static assets such as node_modules, .DS_Store, and .git" — and
  no Pages setting turns the exclusion back off. It fails *silently*: the build
  succeeded, 19 of 40 built files were never uploaded, and each excluded URL fell
  through to the SPA fallback and returned `index.html` with a `200`. The browser
  reported only `Failed to decode downloaded font ... invalid sfntVersion:
  1008813235` — that number is `<!DO` — and the tab-bar icons rendered as empty
  squares. [`scripts/fix-pages-assets.js`](scripts/fix-pages-assets.js) runs as a
  `postbuild` hook, renames the directory to `vendor/` and rewrites the
  references. It exits non-zero if any excluded reference survives, so if a future
  Expo release changes where assets are emitted the build fails loudly instead of
  shipping broken fonts again.
- **Unknown paths return `index.html` with a 200.** The export has no
  `404.html`, so Pages falls back to the SPA behaviour. Cosmetic for the beta;
  copying `dist/+not-found.html` to `dist/404.html` after the build would make it
  a real 404.
- **Cloudflare now steers new projects to Workers with static assets**, calling
  Workers "Cloudflare's primary platform" while Pages remains fully supported.
  This guide uses Pages because that is what was requested and the Git
  integration is a straight fit for a static export. Migrating later is a
  supported path — `dist/` is just static files.
- **Native iOS/Android builds are unaffected.** Expo Go, development builds and
  EAS stay exactly as they are; this guide only adds the web target.
