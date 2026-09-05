# Whop Lesson → Gemini Strategy Backend

A Node/TypeScript backend for the Scarface Trades Mastermind course
intelligence platform. Two generations of functionality live here side by
side:

- **Phase 2 (still the proven core):** takes one already-authorized Whop
  lesson and has Gemini analyze the actual video (audio + on-screen charts)
  to reconstruct the trading strategy taught in it, as structured,
  schema-validated JSON. Unchanged by everything below.
- **Phase 3, PR1 (foundation — this PR):** discovers every lesson in the
  course via Whop's documented APIs, persists it to PostgreSQL, and stores a
  server-side, refreshable Whop session — so lessons no longer have to be
  found and analyzed one pasted URL at a time. See "Phase 3: course
  discovery & persistence" below.

Batch/background processing (Cloud Tasks, a worker service, live progress),
strategy clustering, canonical synthesis, and the course Playbook are **not**
in this PR — see the architecture proposal for the full staged plan.

## Why a backend at all

The Phase 1 frontend is a static GitHub Pages app — anything in it is public.
`GEMINI_API_KEY` must never reach a browser, and the Mux signed URL/token
must never be logged or displayed. This backend is the only place those
secrets are used.

## What it does, end to end

```
Browser (Phase 1 OAuth app)
  │
  │ POST /api/analyze-lesson
  │   Header:  Authorization: Bearer <user's Whop OAuth access token>
  │   Body:    { "lessonUrl": "<Scarface Whop lesson URL>" }
  ▼
Backend (this service, Cloud Run)
  1. Extract lesson_id from lessonUrl
  2. GET the lesson from Whop, using the caller's own bearer token
     (never trusts client-supplied signed_playback_id/token)
  3. Read video_asset.signed_playback_id + signed_video_playback_token
  4. Build https://stream.mux.com/{signed_playback_id}.m3u8?token={token}
     — held only in memory, never logged, never returned to the client
  5. ffmpeg stream-copy remux (no re-encode) → temp .mp4 in a per-request
     temp directory
  6. Upload the .mp4 to the Gemini Files API; poll until state=ACTIVE
  7. Call the Gemini Interactions API with agentic video processing and a
     JSON Schema response_format, asking for strategy reconstruction
     (not a summary) from both audio and visible charts
  8. Zod-validate the JSON Gemini returns
  9. Delete the temp .mp4 and the uploaded Gemini file — always, whether
     the request succeeded or failed
 10. Stream the result back to the browser over Server-Sent Events, so the
     UI can show live stage progress (Retrieving lesson → ... → Validating
     result) before the final JSON arrives
```

## What is never logged, stored, or returned to the browser

- The `Authorization` header / the user's Whop access token
- `signed_video_playback_token`
- The constructed signed Mux HLS URL (in whole or in part)
- `GEMINI_API_KEY`
- The Postgres password (`DB_PASSWORD`) and the refresh-token encryption key
  (`REFRESH_TOKEN_ENCRYPTION_KEY`)
- The stored Whop refresh/access token — encrypted at rest (AES-256-GCM) in
  `auth_sessions`; `GET /api/auth/status` reports connection state only,
  never a token value

All of these are registered with a redaction utility (`src/lib/redact.ts`)
the moment they're known, and every log line goes through it
(`src/lib/logger.ts`). This is covered by automated tests in
`tests/redact.test.ts` and `tests/logger.test.ts`.

## Security model

The Cloud Run service is deployed `--allow-unauthenticated` (the browser
needs to reach it directly), and CORS restricting `ALLOWED_ORIGIN` is a
browser-enforced convention — a non-browser HTTP client can ignore it
entirely. So CORS, `Origin`, and `client_id` are never the security
boundary for anything sensitive; only a verified Whop identity is
(`src/http/middleware/operatorAuth.ts`):

1. The caller presents their own, currently-held Whop access token as
   `Authorization: Bearer <token>`.
2. The backend calls Whop's documented `GET /oauth/userinfo` with that
   token and reads the verified `sub` claim back — never a client-supplied
   `id_token` payload, which nothing here trusts for authorization.
3. That `sub` must equal the `whop_user_id` already persisted in
   `auth_sessions` (the single operator this deployment belongs to) or the
   request is rejected: 401 if there's no session yet or the token itself
   doesn't verify, 403 if it verifies as a genuine but different Whop
   account.

`requireOperator` gates every sensitive route: `GET/POST /api/auth/{status,disconnect}`,
`POST /api/course/sync`, `GET /api/course/lessons`, and the existing
`POST /api/analyze-lesson` (closing off what would otherwise be a public,
Gemini-cost-bearing endpoint reachable by anyone with any Whop token).
`POST /api/auth/session` is the one exception — it's how the very first
operator session gets established — but it runs the same userinfo
verification inline and enforces the identical single-operator rule:
establishing a session as a *different* Whop user than the one already on
file is a 403, not a silent takeover. `GET /healthz` stays public and
returns only `{ok: true}`.

Refreshing the backend's own stored session (independent of the
per-request caller-identity check above) is concurrency-safe: the
check-then-maybe-refresh sequence runs inside one Postgres transaction
holding `pg_advisory_xact_lock` (`src/whop/sessionService.ts`), so two
processes (this API today; a PR2 worker later) can never both read the
same about-to-be-rotated refresh token and both try to spend it.

## Phase 3: course discovery & persistence (PR1)

```
POST /api/auth/session      Frontend hands off {access_token, refresh_token,
                             expires_in} once, right after its existing PKCE
                             exchange. Stored encrypted (AES-256-GCM); the
                             frontend never writes these to localStorage.
GET  /api/auth/status       {connected, status, whopUserId} — never a token.
POST /api/auth/disconnect   Revokes with Whop (best-effort) and deletes the
                             local session.

POST /api/course/sync       Discovers/refreshes the lesson catalog using the
                             backend's own stored session (refreshing it if
                             needed) — not the caller's bearer token.
GET  /api/course/lessons    Reads persisted lessons only; never calls Whop.
```

Course discovery deliberately uses **two** documented Whop endpoints for two
different jobs, joined by lesson id (`src/pipeline/courseSync.ts`):

- `GET /courses/{course_id}` — course metadata and the chapter
  hierarchy/ordering **only**. Its nested lessons are not treated as the
  lesson inventory.
- `GET /course_lessons?course_id=` (cursor-paginated: `first`/`after`,
  `page_info.has_next_page`/`end_cursor`) — the authoritative, paginated
  lesson inventory.

A sync **upserts** every lesson it sees (updating metadata, never touching
any later analysis history) and **soft-archives** (`archived_at`, never
deletes) a previously-synced lesson that disappears from the course.

This is a **single-operator system** today: one stored Whop session
(`auth_sessions`, a singleton row) drives everything. The schema captures
`whop_user_id` now specifically so a later migration to multiple sessions
only has to change a constraint, not the table shape.

Whop access tokens expire after about an hour. Before any call that needs
one, the backend refreshes proactively (once under 5 minutes remain) via
Whop's documented `grant_type=refresh_token` exchange — never reactively
mid-batch. If a refresh itself fails, the session is marked
`auth_required` (never deleted) and `/api/course/sync` returns 401 until
the operator signs in again.

### Database (PostgreSQL)

Migrations use [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate)
against plain `.sql` files in `migrations/`. Nothing here uses an ORM — same
philosophy as the hand-rolled Whop/Gemini clients elsewhere in this codebase.

```bash
# Local dev — point at any disposable Postgres 16+:
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/whop_lesson_dev"
npm run migrate        # apply all pending migrations
npm run migrate:down   # roll back the most recent one
```

Tables (see `migrations/*_init-schema.sql` for the authoritative definition):
`courses`, `lessons`, `auth_sessions`. Batch-processing tables
(`analysis_jobs`, `lesson_analyses`, …) are intentionally not part of this
migration — they land in PR2.

The new course/auth modules are tested against a **real local PostgreSQL**
(not a mock) — see "Tests" below.

## Out of scope (intentionally not implemented yet)

- Cloud Tasks / a background worker / batch analysis of multiple lessons
- Real-time processing progress beyond the existing single-lesson SSE stream
- Strategy clustering, canonical synthesis, the course Playbook
- Discord, YouTube, real-time trading, or brokerage integration

See the Phase 3 architecture proposal for the full PR2–PR4 plan.

## Project layout

```
src/
  config.ts               Env var loading (incl. course/db/encryption config)
  lib/
    redact.ts              Secret redaction (exact-value + pattern backstop)
    logger.ts               Redacting logger
    authHeader.ts             Authorization: Bearer parsing
    cors.ts                    Exact-origin CORS check
    whopUrl.ts                  Lesson URL parsing
    crypto.ts                    AES-256-GCM encrypt/decrypt for the stored refresh token
  db/
    pool.ts                 pg Pool (Cloud SQL socket in prod, TCP locally)
    coursesRepo.ts             Course upsert/read
    lessonsRepo.ts               Lesson sync (upsert + soft-archive) / list
    authSessionRepo.ts             Single-operator session storage (encrypted)
  whop/
    client.ts               Server-side Whop course_lessons GET (Phase 2, unchanged)
    courseClient.ts            GET /courses/{id} + paginated GET /course_lessons
    oauthClient.ts               Server-side refresh_token grant + revoke + verifyAccessToken (userinfo)
    sessionService.ts             Refresh-if-needed access-token helper, advisory-lock single-flight
    lessonUrl.ts                  Builds a lesson's canonical Whop URL
  mux/signedUrl.ts         Signed Mux HLS URL construction
  ffmpeg/remux.ts          Stream-copy remux, sanitized errors
  tempFiles/tempFile.ts    Guaranteed temp-file cleanup
  gemini/
    schema.ts               Zod schema + JSON Schema + extraction prompt
    client.ts                 Gemini Files API + Interactions API wrapper
  pipeline/
    analyzeLesson.ts         Orchestrates the full flow + stage events (Phase 2, unchanged)
    courseSync.ts              Joins course_lessons to chapter metadata, persists
  http/
    app.ts                   Express app wiring
    sse.ts                    Server-Sent-Events helpers
    middleware/
      operatorAuth.ts          requireOperator — verified-identity gate on every sensitive route
    routes/
      analyzeLesson.ts         POST /api/analyze-lesson handler (gated; pipeline itself unchanged)
      auth.ts                    /api/auth/{session,status,disconnect}
      courseSync.ts               POST /api/course/sync
      courseLessons.ts             GET /api/course/lessons
  server.ts                Entrypoint
migrations/                node-pg-migrate SQL migrations
tests/                     Vitest test suite (see "Tests" below)
Dockerfile                 Node 22 + ffmpeg, multi-stage build
.dockerignore
```

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes | — | **Secret.** From Google AI Studio. Set via Secret Manager in Cloud Run (see below) — never commit it, never put it in the Dockerfile. |
| `ALLOWED_ORIGIN` | Yes | — | Must be exactly `https://bubblegum-uwu.github.io` (no path) for the deployed frontend. |
| `GEMINI_MODEL` | No | `gemini-3.8-flash` | Any current Gemini model that supports video understanding. |
| `GEMINI_VIDEO_PROCESSING_MODE` | No | `agentic` | `agentic` or `static`. Agentic is recommended for reading on-screen chart detail across a long video. |
| `WHOP_API_BASE` | No | `https://api.whop.com/api/v1` | Override for Whop's sandbox API if needed. |
| `NODE_ENV` | No | `development` locally, `production` in the container | |
| `MAX_VIDEO_BYTES` | No | `2147483648` (2GB) | Safety cap (not yet enforced on the download itself in this PoC — see "Known limitations"). |
| `PORT` | No | `8080` | Cloud Run injects this automatically. |
| `FFMPEG_PATH` | No | `ffmpeg` | Override if ffmpeg isn't on PATH. |
| `WHOP_CLIENT_ID` | Yes | — | The same public OAuth client_id the frontend uses. Needed server-side now for the refresh-token grant. |
| `WHOP_COURSE_ID` | Yes | — | `cors_4lb7N3oassoZwHJvrufOYy` for Scarface Trades Mastermind. |
| `WHOP_EXPERIENCE_ID` | Yes | — | `exp_gdmood6JIzSsE7`. |
| `WHOP_COURSE_SLUG` | Yes | — | `scarface-trades-mastermind`. |
| `DB_USER` | Yes | — | Cloud SQL app user. |
| `DB_PASSWORD` | Yes | — | **Secret.** Set via Secret Manager, like `GEMINI_API_KEY`. |
| `DB_NAME` | Yes | — | e.g. `whop_lesson_platform`. |
| `INSTANCE_CONNECTION_NAME` | Yes in Cloud Run | — | e.g. `scarface-video-ai:us-central1:whop-lesson-db`. Selects the Cloud SQL unix-socket connection; omit for local dev (uses `DB_HOST`/`DB_PORT`, default `localhost:5432`). |
| `REFRESH_TOKEN_ENCRYPTION_KEY` | Yes | — | **Secret.** Base64-encoded 32 random bytes, e.g. `openssl rand -base64 32`. Encrypts the stored Whop refresh token at rest. |

## Running locally

```bash
npm install
GEMINI_API_KEY=your_key ALLOWED_ORIGIN=http://localhost:5173 npm run dev
```

Requires `ffmpeg` installed locally (`brew install ffmpeg` / `apt install ffmpeg`).

## Tests

The course/auth modules are tested against a **real local PostgreSQL**, not
a mock — set one up once, then `npm test` as usual:

```bash
sudo pg_ctlcluster 16 main start   # or however Postgres 16+ runs locally
createdb whop_lesson_test
DATABASE_URL=postgres://postgres:postgres@localhost:5432/whop_lesson_test npm run migrate
npm test
```

`auth_sessions` is a genuine singleton (single-operator system, by design),
so test files run sequentially (`fileParallelism: false` in
`vitest.config.ts`) rather than racing each other against that one row.
Override the target database with `TEST_DATABASE_HOST` / `_PORT` / `_USER` /
`_PASSWORD` / `_NAME` if `localhost:5432` with `postgres`/`postgres` doesn't
match your setup.

Covers (see `tests/`):
- Authorization header parsing (valid, missing, malformed, multi-value)
- Redaction of Authorization headers, Whop tokens, `signed_video_playback_token`,
  signed Mux URLs, and `GEMINI_API_KEY` — both exact-value and pattern-backstop
- The redacting logger never writes a registered secret to stdout/stderr
- Exact-origin CORS matching (rejects sub-paths, subdomains, http vs https)
- Signed Mux URL construction + full redactability
- ffmpeg stream-copy success, non-zero exit (including a simulated expired
  token / 403), spawn failure — all without leaking the URL/token
- Temp file/directory cleanup after both success and failure
- Gemini structured-output Zod schema (valid payloads, invalid confidence,
  invalid classification, the "no fabricated strategy" refinement, malformed
  input)
- Full pipeline integration tests with fully mocked dependencies: happy
  path, every Whop error code, ffmpeg failure, Gemini upload failure,
  Gemini FAILED processing state, Gemini analysis failure, invalid JSON /
  invalid schema from Gemini, the "no strategy found" success case, and
  that temp files + the Gemini file are cleaned up in every case
- AES-256-GCM encrypt/decrypt round-trip, unique IV per call, tamper/wrong-key rejection
- Course/lesson upsert, soft-archive-and-restore, chapter-order sorting
- Whop course/course-lessons clients: pagination, 401/403/404 mapping
- Whop OAuth refresh/revoke: correct request shape, no `client_secret` ever sent
- Session service: proactive refresh, refresh-token rotation, marks
  `auth_required` (without deleting the row) when refresh itself fails
- Course sync joins `course_lessons` to chapter metadata correctly, including
  a lesson the course tree doesn't mention
- Auth/course HTTP routes: 401 `auth_required`, never returns a token value,
  disconnect always clears the local session even if Whop's revoke fails
- `requireOperator` (unit + real-HTTP end-to-end): unauthenticated calls to
  every protected route are rejected, a verified-but-different Whop user
  gets 403 on every one without reaching its handler, a matching operator
  reaches the real handler, a session-establishment attempt from a
  different Whop user never overwrites the singleton, and no error
  response ever contains the caller's raw bearer token
- Refresh-token concurrency: two simultaneous `getValidAccessToken` calls
  against the same near-expired session result in exactly one call to
  Whop's refresh grant — the second waits for the advisory lock and reuses
  the already-rotated token instead of racing for it

A GitHub Actions workflow (`.github/workflows/pr-checks.yml`) runs the full
backend suite above (migrations, typecheck, test, build) against a
Postgres 16 service container, plus the frontend suite, on every pull
request — no production secrets involved, and it never deploys anything
(deploys stay in `deploy.yml`, triggered only by pushes to `main`).

## Known limitations (acceptable for this PoC)

- `MAX_VIDEO_BYTES` is read but not yet enforced mid-download; ffmpeg is
  trusted to fail naturally on absurd inputs. For a single known ~26-minute
  lesson this is an acceptable simplification.
- No rate limiting on any route. Every sensitive route does now require a
  Whop token independently verified against Whop's userinfo endpoint and
  matched to the persisted operator (see "Security model" below) — but
  nothing stops the one legitimate operator from calling `/api/analyze-lesson`
  in a tight loop. Fine for a single-operator PoC; revisit before wider use.
- Stage progress is delivered via a single long-lived SSE response, not a
  separate job-status endpoint. Good enough for one lesson; would need a
  job queue for concurrent multi-lesson use (explicitly out of scope now).
- `auth_sessions` is a genuine singleton — this is a **single-operator**
  system by design (one Whop identity drives the whole course). The schema
  captures `whop_user_id` specifically so a later migration to multiple
  sessions changes a constraint, not the table shape.
- The exact shape of `GET /courses/{id}`'s nested chapter/lesson objects
  (used only for chapter metadata/ordering, never as the lesson inventory —
  see "Phase 3" above) hasn't been verified against a live authenticated
  call from this development environment. Run `POST /api/course/sync` once
  against the real course early and confirm chapter titles/orders look
  right before relying on it further.
- Every protected route resolves identity by calling Whop's userinfo
  endpoint on every request — correct and simple, but it's an extra network
  round-trip per request. Fine at this traffic level; would be worth caching
  briefly (with a short TTL, not indefinitely) if this ever serves real
  concurrent load.

---

## Deployment guide: Google Cloud Run

### 0. What you'll create/click, end to end

1. A Google Cloud project (if you don't already have one)
2. A Gemini API key from Google AI Studio
3. A secret in Secret Manager holding that key
4. One `gcloud run deploy` command (Cloud Build builds the container for
   you — no local Docker required)

### 1. Get a Gemini API key

1. Go to **[Google AI Studio → API keys](https://aistudio.google.com/apikey)**.
2. Click **Create API key**, choose (or create) a Google Cloud project to
   associate it with.
3. Copy the key. You will put it into Secret Manager in step 4 — never into
   a file you commit.

### 2. Create/select a Google Cloud project

1. Go to the **[Google Cloud Console](https://console.cloud.google.com/)**.
2. Create a new project (or pick an existing one). Note the **Project ID**.
3. Make sure billing is enabled for the project (Cloud Run's free tier
   covers light PoC usage, but a billing account must be attached).

### 3. Install and authenticate the `gcloud` CLI

```bash
# https://cloud.google.com/sdk/docs/install
gcloud init
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### 4. Enable the required APIs and store the Gemini key in Secret Manager

```bash
gcloud services enable run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com

# Create the secret (paste your Gemini API key when prompted, or pipe it in)
printf '%s' 'YOUR_GEMINI_API_KEY' | gcloud secrets create GEMINI_API_KEY \
  --data-file=- \
  --replication-policy=automatic
```

If you ever need to rotate the key:

```bash
printf '%s' 'YOUR_NEW_GEMINI_API_KEY' | gcloud secrets versions add GEMINI_API_KEY --data-file=-
```

**Do not** put the key in the Dockerfile, in a `.env` file that gets built
into the image, in GitHub, or in `gcloud run deploy --set-env-vars`. It is
only ever referenced by name via `--set-secrets` (below), which injects it
as a runtime environment variable that Cloud Run fetches from Secret
Manager — the value itself never appears in your deploy command, shell
history, or the Cloud Run service YAML.

### 4b. Provision Cloud SQL PostgreSQL and run migrations (new in Phase 3)

A **single, non-HA, shared-core** instance is deliberately the starting
point — this is a personal research application, not a customer-facing
production system. Resize or add HA later without any schema change.

```bash
gcloud services enable sqladmin.googleapis.com

gcloud sql instances create whop-lesson-db \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=us-central1 \
  --storage-size=10GB \
  --storage-auto-increase

gcloud sql databases create whop_lesson_platform --instance=whop-lesson-db

DB_PASSWORD=$(openssl rand -base64 24)
gcloud sql users create app_user --instance=whop-lesson-db --password="$DB_PASSWORD"
printf '%s' "$DB_PASSWORD" | gcloud secrets create DB_PASSWORD --data-file=- --replication-policy=automatic

REFRESH_KEY=$(openssl rand -base64 32)
printf '%s' "$REFRESH_KEY" | gcloud secrets create REFRESH_TOKEN_ENCRYPTION_KEY --data-file=- --replication-policy=automatic

INSTANCE_CONNECTION_NAME=$(gcloud sql instances describe whop-lesson-db --format='value(connectionName)')
echo "$INSTANCE_CONNECTION_NAME"   # note this for step 5 and for the migration command below

# Grant the Cloud Run service account access (least privilege — no Owner/Editor):
SERVICE_ACCOUNT=$(gcloud run services describe whop-lesson-gemini-backend --region us-central1 --format='value(spec.template.spec.serviceAccountName)')
gcloud projects add-iam-policy-binding "$(gcloud config get-value project)" \
  --member="serviceAccount:$SERVICE_ACCOUNT" --role="roles/cloudsql.client"
gcloud secrets add-iam-policy-binding DB_PASSWORD \
  --member="serviceAccount:$SERVICE_ACCOUNT" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding REFRESH_TOKEN_ENCRYPTION_KEY \
  --member="serviceAccount:$SERVICE_ACCOUNT" --role="roles/secretmanager.secretAccessor"

# Run migrations once, via the Cloud SQL Auth Proxy, from your machine:
# https://cloud.google.com/sql/docs/postgres/sql-proxy
./cloud-sql-proxy "$INSTANCE_CONNECTION_NAME" &
DATABASE_URL="postgres://app_user:${DB_PASSWORD}@localhost:5432/whop_lesson_platform" npm run migrate
```

### 5. Deploy — no local Docker required

From the `backend/` directory:

```bash
gcloud run deploy whop-lesson-gemini-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout=3600 \
  --memory=2Gi \
  --cpu=2 \
  --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
  --set-env-vars ALLOWED_ORIGIN=https://bubblegum-uwu.github.io,GEMINI_MODEL=gemini-3.8-flash,GEMINI_VIDEO_PROCESSING_MODE=agentic,WHOP_CLIENT_ID=YOUR_WHOP_APP_CLIENT_ID,WHOP_COURSE_ID=cors_4lb7N3oassoZwHJvrufOYy,WHOP_EXPERIENCE_ID=exp_gdmood6JIzSsE7,WHOP_COURSE_SLUG=scarface-trades-mastermind,DB_USER=app_user,DB_NAME=whop_lesson_platform,INSTANCE_CONNECTION_NAME="$INSTANCE_CONNECTION_NAME" \
  --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest,DB_PASSWORD=DB_PASSWORD:latest,REFRESH_TOKEN_ENCRYPTION_KEY=REFRESH_TOKEN_ENCRYPTION_KEY:latest
```

What this does:
- `--source .` tells Cloud Build to build your `Dockerfile` for you — you
  don't need Docker installed locally.
- `--timeout=3600` gives the pipeline the full 60 minutes Cloud Run allows,
  comfortable headroom for downloading, remuxing, uploading, and analyzing
  a ~26-minute video.
- `--allow-unauthenticated` makes the URL reachable directly from the
  browser; access control is still enforced by (a) the exact-origin CORS
  check and (b) Whop validating the caller's own bearer token server-side.
- `--add-cloudsql-instances` lets the service connect to Cloud SQL over a
  Unix socket without a separate proxy sidecar.
- `--set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest` injects the Secret
  Manager secret as the `GEMINI_API_KEY` environment variable at runtime —
  the plaintext key is never part of the deploy command itself.

The command prints a **Service URL** when done, e.g.
`https://whop-lesson-gemini-backend-xxxxx-uc.a.run.app`. That's the URL the
frontend needs (see "Frontend configuration" below).

### 6. Verify

```bash
curl https://YOUR-SERVICE-URL/healthz
# {"ok":true}
```

### 7. Redeploying after changes

Re-run the same `gcloud run deploy` command — Cloud Build rebuilds the
image and Cloud Run rolls out a new revision automatically.

### 8. Frontend configuration

The frontend's build needs to know this backend URL. Set it as
`VITE_BACKEND_URL` when building the frontend (see the frontend README) —
either as a repo/organization variable in the GitHub Actions workflow, or
locally in a `.env.local` file (already gitignored) for development.

It also needs the Whop OAuth `client_id` — the manual "Client ID" field is
gone (Phase 3, PR1). Add a GitHub repository **variable** (Settings →
Secrets and variables → Actions → Variables — not a secret; a client_id is
public by design):

```
VITE_WHOP_CLIENT_ID=<the same client_id already used for WHOP_CLIENT_ID above>
```

Then re-run the Pages deploy workflow so the new build picks it up. If it's
unset, the frontend shows "Whop OAuth is not configured." instead of the
sign-in screen.
