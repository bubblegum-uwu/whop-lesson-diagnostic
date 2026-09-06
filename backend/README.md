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
boundary for anything sensitive; only a verified Whop identity, checked
against **deployment configuration**, is (`src/http/middleware/operatorAuth.ts`):

1. The caller presents their own, currently-held Whop access token as
   `Authorization: Bearer <token>`.
2. The backend calls Whop's documented `GET /oauth/userinfo` with that
   token and reads the verified `sub` claim back — never a client-supplied
   `id_token` payload, which nothing here trusts for authorization.
3. That `sub` must equal **`WHOP_OPERATOR_USER_ID`** — a required backend
   environment variable, not a database value. The persisted
   `auth_sessions.whop_user_id` is checked too, but only as a second,
   independent confirmation; it is never the thing that *grants* access.
   If the two disagree (a stale row from before this check existed, a
   restored backup, a manual edit), the request fails closed with 500
   `operator_configuration_conflict` rather than trusting whichever value
   happens to be in the database.

This closes a trust-on-first-use gap that existed in an earlier version of
this design: with `WHOP_OPERATOR_USER_ID` pinned in configuration, *no*
verified Whop identity can ever become the operator merely by being first
to call an endpoint while `auth_sessions` is empty — the deployment
configuration decides who is allowed to be the operator; the database only
ever confirms who currently is.

`requireOperator` gates every sensitive route: `GET/POST /api/auth/{status,disconnect}`,
`POST /api/course/sync`, `GET /api/course/lessons`, and the existing
`POST /api/analyze-lesson` (closing off what would otherwise be a public,
Gemini-cost-bearing endpoint reachable by anyone with any Whop token).
`POST /api/auth/session` is the one exception — it's how the operator
session actually gets established or refreshed — but it runs the same
userinfo verification and the same `WHOP_OPERATOR_USER_ID` check inline: a
verified identity that isn't the configured operator is a 403, and nothing
is persisted. `GET /healthz` stays public and returns only `{ok: true}`.

**PR2 adds a second, entirely separate identity boundary** for
`POST /internal/ensure-worker-running` (the Cloud Scheduler safety net): a
real Google-signed OIDC identity token, verified server-side
(`src/lib/googleOidc.ts`) against **both** its signature/audience and an
exact match to `SCHEDULER_SERVICE_ACCOUNT_EMAIL`. Same principle as
above — CORS, `Origin`, and a shared query-string secret are explicitly
never acceptable substitutes for this either. This route also never
promotes a job out of `AUTH_REQUIRED`; only a successful, operator-verified
`POST /api/auth/session` reconnect does that.

Refreshing the backend's own stored session (independent of the
per-request caller-identity check above) is concurrency-safe: the
check-then-maybe-refresh sequence runs inside one Postgres transaction
holding `pg_advisory_xact_lock` (`src/whop/sessionService.ts`), so two
processes (this API today; a PR2 worker later) can never both read the
same about-to-be-rotated refresh token and both try to spend it.

### Configuring the operator (`WHOP_OPERATOR_USER_ID`)

This deployment has exactly one authorized operator, and you set who that
is — the application refuses to start without it:

```
WHOP_OPERATOR_USER_ID=user_xxxxxxxxxxxxx
```

This is a plain Whop account identifier, **not a secret** — store it as a
normal Cloud Run environment variable, never in `VITE_*` (it must never
become a frontend-enforced authorization mechanism) and never in Secret
Manager (it doesn't need to be; it grants nothing on its own without a
real, freshly-verified Whop access token to go with it).

**Finding your own value, safely:** you likely don't know your Whop `sub`
offhand, and there's no safe way to get it that involves pasting a token
anywhere or logging one. Instead, open the deployed (or local) frontend and
expand **"First-time setup: find my Whop user ID"** (visible above the
Course view). Click through Whop's normal sign-in — this reuses the exact
OAuth flow the app already runs, calls **Whop's own** `/oauth/userinfo`
endpoint **directly from your browser**, and displays the returned `sub`
on your screen. It never touches this app's backend (works even before
`WHOP_OPERATOR_USER_ID` is set or the backend is deployed at all), never
asks you to paste a token anywhere, and the displayed value is not itself
a credential — copy it into `WHOP_OPERATOR_USER_ID` yourself.

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

Tables (see `migrations/*_init-schema.sql` for PR1, and
`migrations/*_pr2-analysis-jobs.sql` for PR2): `courses`, `lessons`,
`auth_sessions`, `analysis_jobs`, `job_events`, `lesson_analyses`,
`strategy_instances`, `usage_records`.

The new course/auth modules are tested against a **real local PostgreSQL**
(not a mock) — see "Tests" below.

## Phase 3 PR2: durable batch processing

Turns the read-only Course table into an operational dashboard that can
analyze many lessons unattended — queue a batch, close the browser, and come
back to find it done. See §5 below for the concrete architecture; this
section covers what changed and why.

### Why not Cloud Tasks

An earlier design used Cloud Tasks → a long-running HTTP request on a private
Cloud Run **service**. Two real problems ruled it out:

1. **The 30-minute Cloud Tasks HTTP dispatch deadline.** Lessons run
   30–45+ minutes; a single request held open for the whole pipeline could
   be retried by Cloud Tasks while the original attempt was still running,
   causing duplicate Gemini spend.
2. **Cloud Tasks task-name tombstones.** A deterministic task name derived
   from `job_id` (for dedupe) can't be immediately reused after that task
   completes or is deleted, which broke the planned same-`job_id` retry.

### The actual architecture: Postgres queue + Cloud Run Job

```
Browser → Public API (Cloud Run SERVICE, operator-gated)
            │
            ├─ enqueue: INSERT analysis_jobs (QUEUED) + trigger a Cloud Run
            │  JOB execution via the Admin API (async — never awaited)
            │
Cloud Run JOB (whop-lesson-gemini-worker, private, SERVICE_ROLE=worker)
            │
            ├─ pg_try_advisory_lock — a second concurrent execution that
            │  can't acquire it exits immediately (cheap, harmless)
            ├─ loop: claim one eligible job (`FOR UPDATE SKIP LOCKED`,
            │  including reclaiming any job whose lease expired — crash
            │  recovery, not a "potentially stale" label) → run the SAME
            │  analyzeLesson() pipeline PR1 already proved out → persist
            │  lesson_analyses / strategy_instances / usage_records
            │  → exit once no eligible work remains
            │
Cloud Scheduler (~every 5 min) → POST /internal/ensure-worker-running
            (Google-signed OIDC only — never CORS/Origin/a shared secret)
            → if a due retry or a lease-expired job exists and no execution
              is currently running, trigger one. NEVER resumes AUTH_REQUIRED
              jobs — only a successful POST /api/auth/session reconnect does.
```

Cloud Run **Jobs** (not a second Service) are the processor: no public or
private HTTP endpoint exists for the worker at all — it's started only via
the Cloud Run Admin API's `jobs.run`, gated purely by IAM
(`roles/run.invoker` scoped to that one Job resource). Task timeout is
`12h`, comfortably above any real lesson, with Cloud Run Job's own
infrastructure-level retries disabled (`--max-retries=0`) — retry behavior
is owned entirely by `analysis_jobs.attempt_count`/`next_retry_at`, not
layered infrastructure retries.

**Job leases, not just status.** `analysis_jobs.lease_owner` +
`lease_expires_at` let a later execution safely reclaim a job whose worker
crashed mid-processing, and every lease-guarded write (`renewLease`,
`markSucceeded`, …) is fenced: an execution that has been reclaimed gets
`false` back and MUST NOT persist a result. The final `lesson_analyses`
insert happens in the same transaction as that fencing check, so a
reclaimed/duplicate worker can never write a second result for one job
(`lesson_analyses.job_id` is also `UNIQUE` as defense in depth).

**Retries.** Transient failures (429/500/502/503/504, network/timeout) go
back to `QUEUED` with a bounded-exponential `next_retry_at` and release
their lease so the loop moves on to the next lesson — never a blocking
sleep. Permanent failures (400/403/404, schema validation, a non-timeout
ffmpeg failure) are terminal (`FAILED`). A Whop refresh failure is
`AUTH_REQUIRED`, parked until reconnect.

**Idempotency.** An `analysis_fingerprint` (lesson id + Gemini model +
prompt/schema/extractor version) is checked before any Gemini spend — an
identical successful analysis is never redone. `[ Re-analyze ]` explicitly
opts out of that check and creates a **new** job/analysis row rather than
overwriting the old one.

**Cancellation is QUEUED-only.** Once a job has been claimed and started
processing, there is no reliable way to abort an in-flight ffmpeg/Gemini
call from a Cloud Run Job — `[ Cancel ]` is only offered while `QUEUED`.
This is a documented limitation, not a bug.

## Out of scope (intentionally not implemented yet)

- Strategy clustering across lessons, canonical synthesis, the course Playbook
- Discord, YouTube, real-time trading, or brokerage integration
- Reliable cancellation of in-flight (already-claimed) processing

See the Phase 3 architecture proposal for the full PR3–PR4 plan.

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
      auth.ts                    /api/auth/{session,status,disconnect} (+ PR2 AUTH_REQUIRED resume)
      courseSync.ts               POST /api/course/sync
      courseLessons.ts             GET /api/course/lessons (+ PR2 job/analysis join)
      lessonAnalysisDetail.ts       GET /api/course/lessons/:id/analysis — full validated JSON
      analysisJobs.ts                POST /api/analysis/jobs{,/​:id/retry,/​:id/cancel}, GET /:id
      analysisSummary.ts              GET /api/analysis/summary — dashboard counters
      analysisEvents.ts                 GET /api/analysis/events — SSE notification layer
      internal.ts                        POST /internal/ensure-worker-running (Scheduler, OIDC-gated)
  worker/
    advisoryLock.ts          pg_try_advisory_lock — the single-worker guard (PR2)
    mainLoop.ts                Cloud Run Job entrypoint: claim → process → persist, until no work remains
  jobs/
    runJobTrigger.ts          Triggers a Cloud Run Job execution via the Admin API (fire-and-forget)
  db/
    analysisJobsRepo.ts       Claim/lease/retry/cancel — the durable queue (PR2)
    jobEventsRepo.ts            Progress events for the SSE layer
    lessonAnalysesRepo.ts        Terminal analysis results, fingerprint lookups
    strategyInstancesRepo.ts      One row per extracted strategy
    usageRecordsRepo.ts            Token usage / cost per analysis
  pricing/
    geminiPricing.ts          Versioned cost table — never a Gemini call to estimate
  lib/
    googleOidc.ts             Verifies the Scheduler's Google-signed identity token
  server.ts                Entrypoint — branches on SERVICE_ROLE (api server vs. worker loop)
  workerDeps.ts             Shared wiring for the worker entrypoint
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
| `WHOP_OPERATOR_USER_ID` | Yes | — | Not a secret. The Whop user id (`user_...`) of the one operator allowed to use this deployment — the root of trust for `requireOperator`. App refuses to start if missing or malformed. See "Configuring the operator" above for how to safely find your own value. |
| `WHOP_COURSE_ID` | Yes | — | `cors_4lb7N3oassoZwHJvrufOYy` for Scarface Trades Mastermind. |
| `WHOP_EXPERIENCE_ID` | Yes | — | `exp_gdmood6JIzSsE7`. |
| `WHOP_COURSE_SLUG` | Yes | — | `scarface-trades-mastermind`. |
| `DB_USER` | Yes | — | Cloud SQL app user. |
| `DB_PASSWORD` | Yes | — | **Secret.** Set via Secret Manager, like `GEMINI_API_KEY`. |
| `DB_NAME` | Yes | — | e.g. `whop_lesson_platform`. |
| `INSTANCE_CONNECTION_NAME` | Yes in Cloud Run | — | e.g. `scarface-video-ai:us-central1:whop-lesson-db`. Selects the Cloud SQL unix-socket connection; omit for local dev (uses `DB_HOST`/`DB_PORT`, default `localhost:5432`). |
| `REFRESH_TOKEN_ENCRYPTION_KEY` | Yes | — | **Secret.** Base64-encoded 32 random bytes, e.g. `openssl rand -base64 32`. Encrypts the stored Whop refresh token at rest. |
| `SERVICE_ROLE` | No | `api` | `api` mounts the public HTTP routes (the Cloud Run **service**); `worker` runs the PR2 batch-processing claim loop and mounts no HTTP routes at all (the Cloud Run **Job**). Same image, same env-var surface, different role. |
| `GCP_PROJECT_ID` | Yes for `api` role | — | Used to build the Cloud Run Job's resource name when triggering an execution. |
| `GCP_REGION` | No | `us-central1` | Region of the Cloud Run Job. |
| `CLOUD_RUN_JOB_NAME` | Yes for `api` role | — | `whop-lesson-gemini-worker`. |
| `SCHEDULER_SERVICE_ACCOUNT_EMAIL` | Yes for `api` role | — | The **only** identity `POST /internal/ensure-worker-running` trusts — verified via a real Google-signed OIDC token, never CORS/Origin/a shared secret. |
| `PUBLIC_API_BASE_URL` | Yes for `api` role | — | This service's own Cloud Run URL — the expected `aud` claim on the Scheduler's OIDC token. |

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
- `WHOP_OPERATOR_USER_ID` pinning: application startup fails outright on a
  missing or malformed value; an empty database with a verified-but-wrong
  Whop user is rejected with 403 and nothing persisted (no
  first-authenticated-user-wins path exists); the configured operator can
  establish/re-establish a session against an empty database; a persisted
  session that disagrees with the configured operator fails closed
  (`operator_configuration_conflict`, 500) rather than being trusted or
  silently overwritten; `requireOperator` requires the verified caller to
  match configuration, not merely whatever is in the database

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
- The original single-lesson SSE flow (`POST /api/analyze-lesson`, still
  fully intact and used by the standalone "Whop Lesson Media Diagnostic"
  section) delivers progress via one long-lived response — fine for one
  lesson at a time. PR2's batch flow uses a durable Postgres queue instead
  (see "Phase 3 PR2" above) specifically so it doesn't depend on the
  browser or the connection staying open.
- **Cancellation only works while a job is `QUEUED`.** Once a Cloud Run Job
  execution has claimed a lesson and started processing it, there is no
  reliable way to abort the in-flight ffmpeg/Gemini call — `[ Cancel ]` is
  not offered past that point. This is a deliberate, documented limitation,
  not an oversight.
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
  --set-env-vars ALLOWED_ORIGIN=https://bubblegum-uwu.github.io,GEMINI_MODEL=gemini-3.8-flash,GEMINI_VIDEO_PROCESSING_MODE=agentic,WHOP_CLIENT_ID=YOUR_WHOP_APP_CLIENT_ID,WHOP_OPERATOR_USER_ID=YOUR_WHOP_USER_ID,WHOP_COURSE_ID=cors_4lb7N3oassoZwHJvrufOYy,WHOP_EXPERIENCE_ID=exp_gdmood6JIzSsE7,WHOP_COURSE_SLUG=scarface-trades-mastermind,DB_USER=app_user,DB_NAME=whop_lesson_platform,INSTANCE_CONNECTION_NAME="$INSTANCE_CONNECTION_NAME" \
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

### 9. PR2: one-time setup for durable batch processing (not automated — run these yourself)

These commands are **not** run by CI and are not part of the existing
`gcloud run deploy` step above — provision them once, manually, after the
API service already exists (step 5).

```bash
# Dedicated least-privilege identity for the worker (separate from the API's
# own runtime service account):
gcloud iam service-accounts create whop-lesson-worker-sa \
  --display-name="whop-lesson-gemini-worker runtime identity"

gcloud projects add-iam-policy-binding "$(gcloud config get-value project)" \
  --member="serviceAccount:whop-lesson-worker-sa@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"
gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:whop-lesson-worker-sa@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding DB_PASSWORD \
  --member="serviceAccount:whop-lesson-worker-sa@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding REFRESH_TOKEN_ENCRYPTION_KEY \
  --member="serviceAccount:whop-lesson-worker-sa@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# The Cloud Run JOB itself — same image as the API service, no public/private
# HTTP endpoint at all (Jobs are only ever started via the Admin API):
gcloud run jobs create whop-lesson-gemini-worker \
  --image=<the same image URL the API service is currently running — see `gcloud run services describe whop-lesson-gemini-backend --format='value(spec.template.spec.containers[0].image)'`> \
  --region us-central1 \
  --service-account="whop-lesson-worker-sa@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
  --set-env-vars SERVICE_ROLE=worker,ALLOWED_ORIGIN=https://bubblegum-uwu.github.io,GEMINI_MODEL=gemini-3.8-flash,GEMINI_VIDEO_PROCESSING_MODE=agentic,WHOP_CLIENT_ID=YOUR_WHOP_APP_CLIENT_ID,WHOP_OPERATOR_USER_ID=YOUR_WHOP_USER_ID,WHOP_COURSE_ID=cors_4lb7N3oassoZwHJvrufOYy,WHOP_EXPERIENCE_ID=exp_gdmood6JIzSsE7,WHOP_COURSE_SLUG=scarface-trades-mastermind,DB_USER=app_user,DB_NAME=whop_lesson_platform,INSTANCE_CONNECTION_NAME="$INSTANCE_CONNECTION_NAME" \
  --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest,DB_PASSWORD=DB_PASSWORD:latest,REFRESH_TOKEN_ENCRYPTION_KEY=REFRESH_TOKEN_ENCRYPTION_KEY:latest \
  --tasks=1 --parallelism=1 \
  --task-timeout=12h \
  --max-retries=0

# Let the EXISTING API service trigger executions of this Job (least
# privilege: scoped to this one Job resource, not the project):
API_SERVICE_ACCOUNT=$(gcloud run services describe whop-lesson-gemini-backend --region us-central1 --format='value(spec.template.spec.serviceAccountName)')
gcloud run jobs add-iam-policy-binding whop-lesson-gemini-worker \
  --region=us-central1 \
  --member="serviceAccount:$API_SERVICE_ACCOUNT" \
  --role="roles/run.invoker"

# Redeploy the API service itself with the new PR2 env vars it needs to
# trigger that Job (GCP_PROJECT_ID/CLOUD_RUN_JOB_NAME/etc. — add these to
# the SAME --set-env-vars list already used in step 5's gcloud run deploy):
#   SERVICE_ROLE=api (or omit — it's the default)
#   GCP_PROJECT_ID=$(gcloud config get-value project)
#   GCP_REGION=us-central1
#   CLOUD_RUN_JOB_NAME=whop-lesson-gemini-worker
#   SCHEDULER_SERVICE_ACCOUNT_EMAIL=<created below>
#   PUBLIC_API_BASE_URL=<the API service's own URL from step 5's output>

# The Cloud Scheduler safety net — the ONLY way a due retry or a
# lease-expired job gets picked up when nobody's browser is open:
gcloud services enable cloudscheduler.googleapis.com
gcloud iam service-accounts create whop-lesson-scheduler-sa \
  --display-name="Cloud Scheduler -> ensure-worker-running"
gcloud run services add-iam-policy-binding whop-lesson-gemini-backend \
  --region=us-central1 \
  --member="serviceAccount:whop-lesson-scheduler-sa@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/run.invoker"
gcloud scheduler jobs create http ensure-lesson-worker-running \
  --location=us-central1 \
  --schedule="*/5 * * * *" \
  --uri="<PUBLIC_API_BASE_URL>/internal/ensure-worker-running" \
  --http-method=POST \
  --oidc-service-account-email="whop-lesson-scheduler-sa@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --oidc-token-audience="<PUBLIC_API_BASE_URL>"
```

Set `SCHEDULER_SERVICE_ACCOUNT_EMAIL` on the API service to
`whop-lesson-scheduler-sa@<project>.iam.gserviceaccount.com` — that route
rejects every identity except this exact one, regardless of Origin/CORS.

**Cost**: Cloud Run Jobs bill only for actual execution time (no
`min-instances`, no idle charge), and Cloud Scheduler's first 3 jobs/month
are free. Expect **~$0 additional fixed monthly cost** — the only new spend
is the variable Gemini/compute cost of however many lessons you actually
batch-analyze, which you already control via manual selection.
