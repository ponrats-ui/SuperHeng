# Deploying SuperHeng (Cloudflare Pages + Render)

Production deploy guide for the beta. Two pieces ship separately:

| Piece | Platform | Source | Build | Serves |
|---|---|---|---|---|
| Web frontend | **Cloudflare Pages** | `superheng-app/` | `npm run build` → `dist/` | `https://superheng.pages.dev` |
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
   - `SUPABASE_URL` — `https://<project-ref>.supabase.co`
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

Expect HTTP 200, `"status": "ok"`, and the Supabase dependency reported as
reachable. Render uses this same endpoint as its health check, so a deploy with a
bad database credential fails here rather than on a user's first request.

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
`CORS_ORIGINS=https://superheng.pages.dev`,
`CORS_ORIGIN_REGEX=^https://([a-z0-9-]+\.)?superheng\.pages\.dev$`,
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
takes roughly a **minute** to wake on the next request. Engineers testing the
site will see one very slow first load, and the dashboard's offline banner may
appear if the frontend times out before the API wakes. If that is unacceptable
during the beta, switch the service to a paid **Starter** instance in the
dashboard (or in `render.yaml`, then re-apply) — the instance always stays warm.

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

4. Add environment variables (Pages → Settings → Environment variables). Set them
   for **both** Production and Preview:

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_API_URL` | `https://superheng-api.onrender.com` |
| `NODE_VERSION` | `22.16.0` |

`EXPO_PUBLIC_API_URL` is **inlined at build time**. Changing it does nothing until
you trigger a new deployment — saving the variable is not enough.

`NODE_VERSION` pins the build image's Node. Metro requires
`^20.19.4 || ^22.13.0 || ^24.3.0 || >= 25.0.0`; 22.16.0 is already the Pages
default, so this is only about making it explicit. Deliberately set *only* this
one — Pages also honours `.nvmrc` and `.node-version`, and the docs do not state
which wins, so mixing methods is how environments drift.

5. **Save and Deploy**. The site lands at `https://superheng.pages.dev`
   (`<project-name>.pages.dev`; the name comes from `wrangler.toml`).

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
CORS_ORIGINS=https://superheng.pages.dev
CORS_ORIGIN_REGEX=^https://([a-z0-9-]+\.)?superheng\.pages\.dev$
```

and delete `CORS_ALLOW_CREDENTIALS`.

- `CORS_ORIGINS` is a comma-separated list of **origins** — scheme, host, port,
  no trailing slash, no path. Add a custom domain here too when you attach one,
  e.g. `https://superheng.pages.dev,https://app.superheng.app`.
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

1. Open `https://superheng.pages.dev` in a browser and open DevTools → Console.
   - **No CORS or "mixed content" errors.** All requests must be `https://`.
   - The header shows a live state, not the red `OFFLINE` badge.
   - "Draws analysed" and "Latest draw" are populated rather than `—`.
2. Click through Dashboard, My Number, Insights, Performance. Each is a separate
   static HTML file on Pages, so a blank tab usually means a missing route:
   `curl -s -o /dev/null -w '%{http_code}\n' https://superheng.pages.dev/insights`
   should print `200`.
3. Open a pull request to confirm previews work: Cloudflare comments the preview
   URL, and the API accepts it via `CORS_ORIGIN_REGEX`.
4. Run the API's non-browser path too — this proves the backend, independent of
   CORS (browsers enforce CORS; `curl` does not):

```bash
curl -s "https://superheng-api.onrender.com/api/predict/basic?limit=100" | head -c 400
```

---

## Step 5 — Shipping updates later

- **Backend:** push to `main`. Render redeploys automatically
  (`autoDeployTrigger: commit`).
- **Frontend:** push to `main`. Cloudflare rebuilds and republishes.
- **Changing the API URL or any `EXPO_PUBLIC_*` variable:** update the variable,
  then **trigger a new deployment** — a rebuild is what inlines it.

---

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
  before the URL is publicised.
- **CORS is wide open on purpose and `CORS_ALLOW_CREDENTIALS=true`** (see
  Step 3). Both are beta-only and must be reverted before launch, and before any
  cookie-based login is introduced.
- **Free Render instances sleep** (see Step 1). Expect a ~1 minute cold start
  after 15 idle minutes.
- **Supabase connection pooling.** Each Render instance opens its own
  connections. One instance is harmless; scaling the service up needs the pooler
  endpoint (`...pooler.supabase.com`) rather than direct connections.
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
