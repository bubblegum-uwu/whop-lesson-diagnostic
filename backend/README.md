# Whop Lesson → Gemini Strategy Backend (Phase 2)

A small Node/TypeScript backend that takes one already-authorized Whop
lesson and has Gemini analyze the actual video (audio + on-screen charts) to
reconstruct the trading strategy taught in it, as structured, schema-validated
JSON.

This is a **single-lesson proof of concept**. It does not crawl courses,
queue multiple lessons, use a database, or touch Discord/YouTube/trading —
see "Out of scope" below.

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

All of these are registered with a redaction utility (`src/lib/redact.ts`)
the moment they're known, and every log line goes through it
(`src/lib/logger.ts`). This is covered by automated tests in
`tests/redact.test.ts` and `tests/logger.test.ts`.

## Out of scope (intentionally not implemented)

- Whole-course crawling or multi-lesson queues
- A database of any kind
- Discord, YouTube, real-time trading, or brokerage integration

## Project layout

```
src/
  config.ts               Env var loading
  lib/
    redact.ts              Secret redaction (exact-value + pattern backstop)
    logger.ts               Redacting logger
    authHeader.ts             Authorization: Bearer parsing
    cors.ts                    Exact-origin CORS check
    whopUrl.ts                  Lesson URL parsing
  whop/client.ts           Server-side Whop course_lessons GET
  mux/signedUrl.ts         Signed Mux HLS URL construction
  ffmpeg/remux.ts          Stream-copy remux, sanitized errors
  tempFiles/tempFile.ts    Guaranteed temp-file cleanup
  gemini/
    schema.ts               Zod schema + JSON Schema + extraction prompt
    client.ts                 Gemini Files API + Interactions API wrapper
  pipeline/analyzeLesson.ts  Orchestrates the full flow + stage events
  http/
    app.ts                   Express app wiring
    sse.ts                    Server-Sent-Events helpers
    routes/analyzeLesson.ts    POST /api/analyze-lesson handler
  server.ts                Entrypoint
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

## Running locally

```bash
npm install
GEMINI_API_KEY=your_key ALLOWED_ORIGIN=http://localhost:5173 npm run dev
```

Requires `ffmpeg` installed locally (`brew install ffmpeg` / `apt install ffmpeg`).

## Tests

```bash
npm test
```

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

## Known limitations (acceptable for this PoC)

- `MAX_VIDEO_BYTES` is read but not yet enforced mid-download; ffmpeg is
  trusted to fail naturally on absurd inputs. For a single known ~26-minute
  lesson this is an acceptable simplification.
- No rate limiting / no shared secret beyond "the caller must present a
  Whop token that Whop itself validates." Fine for a single-user PoC;
  revisit before wider use.
- Stage progress is delivered via a single long-lived SSE response, not a
  separate job-status endpoint. Good enough for one lesson; would need a
  job queue for concurrent multi-lesson use (explicitly out of scope now).

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
  --set-env-vars ALLOWED_ORIGIN=https://bubblegum-uwu.github.io,GEMINI_MODEL=gemini-3.8-flash,GEMINI_VIDEO_PROCESSING_MODE=agentic \
  --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest
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
either as a repo/organization secret in the GitHub Actions workflow, or
locally in a `.env.local` file (already gitignored) for development.
