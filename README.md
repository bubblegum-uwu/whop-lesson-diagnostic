# Whop Lesson Media Diagnostic (Proof of Concept)

A tiny, client-side, browser-only diagnostic app for **one** Whop course
(*Scarface Trades Mastermind*) and **one** test lesson. It authenticates you
directly with Whop using **documented OAuth 2.1 + PKCE**, then calls the
**documented** Whop endpoint:

```
GET https://api.whop.com/api/v1/course_lessons/{lesson_id}
```

...and shows a sanitized summary of what Whop's official API exposes about
that lesson's video/media metadata.

## What this app deliberately does NOT do

- No HTML scraping of whop.com.
- No browser cookies used for auth.
- Never asks for your Whop password.
- Never requests, stores, or displays a `client_secret`. Only a public
  `client_id` is used (PKCE public client — this is Whop's documented,
  recommended flow for browser apps).
- Never displays the raw `signed_video_playback_token` value — only whether
  one is present (`signed_video_playback_token_present: true/false`).
- Never attempts to bypass DRM, access controls, or circumvent a 401/403.
- No YouTube ingestion, no Discord, no trading logic, no Gemini integration,
  and no generalized multi-course ingestion platform. This is scoped to one
  lesson lookup only.

## How it works

1. You enter your Whop OAuth `client_id` (not a secret) and the lesson URL.
2. The app redirects you to Whop to sign in and consent to the scopes
   `openid profile courses:read`.
3. Whop redirects back with an authorization `code`. The app exchanges it for
   an access token using PKCE (`code_verifier`), calling
   `POST https://api.whop.com/oauth/token`. No client secret is ever sent.
4. The app parses the lesson URL to extract `experience_id`, `course_id`, and
   `lesson_id`, then calls
   `GET https://api.whop.com/api/v1/course_lessons/{lesson_id}` with your
   access token.
5. The response is sanitized (allow-listed fields only, token values
   stripped down to presence booleans) and rendered as JSON in the browser.
6. The access token is held only in memory for the duration of that one API
   call and is never logged, displayed, or persisted (no localStorage,
   sessionStorage, or cookies are used for tokens). The PKCE verifier/state
   are stored in `sessionStorage` only, and are cleared immediately after
   use or on error.

## What the result shows

When present, the sanitized result includes:

- `lesson.id`, `title`, `lesson_type`, `visibility`, `content`
- `embed_type`, `embed_id`
- `video_asset.id`, `asset_id`, `duration_seconds`, `audio_only`, `status`,
  `playback_id`, `signed_playback_id`
- `video_asset.signed_video_playback_token_present` (`true`/`false` — never
  the token itself)

## Error handling

- **401** → `AUTHENTICATION FAILED` (HTTP status + sanitized Whop error)
- **403** → `AUTHENTICATED BUT ACCESS DENIED` (HTTP status + sanitized Whop
  error) — this tells you whether normal course-member access is sufficient
  for the API, or whether it requires elevated/admin scopes.
- **404** → shown as its own distinct case (`LESSON NOT FOUND`).
- No retries, workarounds, or fallback scraping are attempted for any of
  the above.

---

## 1. Enabling GitHub Pages

1. Push this repository to GitHub.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. Push to `main` (or run the workflow manually from the **Actions** tab —
   "Build, test, and deploy to GitHub Pages" → **Run workflow**).
5. The included workflow (`.github/workflows/deploy.yml`) will:
   - install dependencies,
   - run the Vitest suite (the deploy fails if tests fail),
   - build with `VITE_BASE_PATH=/<your-repo-name>/`,
   - deploy `dist/` to GitHub Pages.
6. Once deployed, your app URL will be:
   `https://<your-github-username>.github.io/<your-repo-name>/`

## 2. What redirect URL to register in Whop

The app itself displays the exact redirect URI to register, computed from
wherever it's currently running (so it's correct for local dev *and* for
your deployed GitHub Pages URL). It will be one of:

- Local dev: `http://localhost:5173/`
- GitHub Pages: `https://<your-github-username>.github.io/<your-repo-name>/`

Register **both** (one for local testing, one for the deployed diagnostic)
under your Whop app's OAuth redirect URIs — Whop requires an **exact match**,
including the trailing slash.

## 3. How to create/select a Whop OAuth application

1. Go to the [Whop Developer Dashboard](https://whop.com/dashboard/developer).
2. Create a new app, or select an existing one you control.
3. Open the app's **OAuth** section and add the redirect URI(s) from step 2
   above (exact match required for each URI you plan to use).
4. Copy the app's `client_id` (looks like `app_xxxxxxxxxxxx`). As of Phase 3
   this is set once as a build-time variable (see step 5 below), not pasted
   into the UI. **Do not** copy or use the `client_secret` anywhere in this
   app — it's not needed for the PKCE flow and this app never asks for it.

## 4. How to select `courses:read`

Still in the Whop Dashboard, in your app's OAuth settings, click **"View
available scopes"** and enable `courses:read` (in addition to the standard
`openid` and `profile` scopes, which don't need separate dashboard
enablement). This diagnostic requests exactly:

```
openid profile courses:read
```

and no other scopes.

## 5. How to configure the public `client_id` (Phase 3: no longer typed into the UI)

The Client ID input field is gone — it's public configuration, set once at
build time, not something to paste in every session:

1. Locally: put `VITE_WHOP_CLIENT_ID=app_xxxxxxxxxxxx` in a `.env.local` file
   (already gitignored).
2. Deployed: add it as a GitHub repository **variable** (Settings → Secrets
   and variables → Actions → Variables — not a secret, since a client_id is
   public by design), then re-run the Pages deploy workflow.

If it's unset, the app shows **"Whop OAuth is not configured."** instead of
a sign-in screen — it never prompts you to type one in.

Once configured, the app opens on the **Course** view: sign in with Whop,
then Sync Course to discover every lesson in Scarface Trades Mastermind.
Clicking **Analyze** on a lesson hands off to the single-lesson diagnostic
flow below, pre-filled with that lesson's URL — this proven flow is
otherwise completely unchanged.

Every Course-view action (status, sync, disconnect) requires presenting
your current Whop access token, which the backend independently verifies
and checks against `WHOP_OPERATOR_USER_ID` — a required backend
configuration value naming the one Whop account allowed to use this
deployment; not something CORS, an `Origin` header, or the database's own
contents could ever safely decide. Since this token is only ever held in
memory (never localStorage), **reloading the page shows "Connect Whop"
again**, even though the backend's own stored session is still valid —
sign in again to pick the Course view back up.

Don't know your own Whop user id yet? Expand **"First-time setup: find my
Whop user ID"** above the Course view — it signs you in and asks Whop
directly (never this app's backend) who you are, so you can copy the
result into `WHOP_OPERATOR_USER_ID`. See `backend/README.md`'s "Security
model" for the full design.

**Phase 3 PR2** turns the Course table into a batch-processing dashboard:
select any number of lessons (checkboxes, "Select All Unanalyzed"), queue
them with **Analyze Selected**/**Analyze All Unanalyzed**, and close the
browser — a Cloud Run Job keeps working durably in Postgres and the table
reconstructs live status, progress, and results the moment you come back.
See `backend/README.md`'s "Phase 3 PR2" section for the underlying
queue/worker architecture.

A follow-up UX pass reworked the table itself into a proper operational
dashboard for 28+ lessons at once: the main table is summary-only (Lesson,
Chapter, Duration, Status, Progress, Result, Cost, Actions) with a sticky
search/filter toolbar and a sticky header, so nothing requires scrolling to
a distant horizontal scrollbar. Clicking **View** opens the full analysis —
strategy names, rule counts, confidence, cost, and a collapsed-by-default
raw-JSON viewer with copy/download — in a right-side drawer instead of
expanding the table row, so the table's own layout never shifts. Search,
status/chapter/strategy filters, and page-size (25/50/100) all work over
the already-loaded lesson list. On narrow screens the table becomes a
compact card list instead of shrinking a wide table.

## 6. How to run this diagnostic

### Locally

```bash
npm install
npm run dev
```

Open the printed local URL (typically `http://localhost:5173/`), register
that exact URL as a redirect URI in your Whop app (step 2), then use the
form as described above.

### Tests

```bash
npm run test
```

Runs the Vitest suite covering:

1. Parsing the exact Scarface Trades Mastermind lesson URL.
2. Extracting the `experience_id`.
3. Extracting the `course_id`.
4. Extracting the `lesson_id`.
5. Sanitizing a Whop lesson API response (allow-listed fields only, token
   values reduced to presence booleans).
6. Ensuring OAuth tokens (`access_token`, `refresh_token`, `id_token`) and
   the raw `signed_video_playback_token` / `client_secret` can never appear
   in the diagnostic JSON shown in the UI (including a defense-in-depth
   guard that throws if one is ever detected).

### Production build

```bash
npm run build
npm run preview
```

## Project layout

```
src/
  lib/
    whopUrl.ts            # Lesson URL parsing (experience/course/lesson IDs)
    whopTypes.ts           # Types mirroring Whop's documented CourseLesson schema
    sanitize.ts             # Allow-list sanitization of the raw API response
    whopApi.ts               # Documented course_lessons GET call + status handling
    diagnosticPayload.ts      # Builds the exact JSON shown in the UI + token-leak guard
    sessionConfig.ts           # sessionStorage-only, non-secret config (which OAuth flow + lesson URL)
    backendConfig.ts            # Reads VITE_BACKEND_URL (Phase 2, optional)
    scarfaceCourseConfig.ts       # Phase 3: VITE_WHOP_CLIENT_ID + the one course's fixed IDs
    courseApi.ts                  # Phase 3: client for /api/auth/*, /api/course/*, and PR2's /api/analysis/*
    whopIdentify.ts                 # Security fix: calls Whop's userinfo directly — never this app's backend
    analyzeLessonClient.ts            # SSE client for the Phase 2 backend
    strategyTypes.ts                    # Display types for the Gemini strategy result
    __tests__/                        # Vitest tests
  oauth/
    pkce.ts                # PKCE verifier/state/nonce generation (sessionStorage only)
    whopOAuth.ts            # Authorize URL + code-for-token exchange (no client_secret)
  components/
    ConfigForm.tsx         # Lesson URL input (client_id is build-time config, not typed in)
    DiagnosticResult.tsx    # Sanitized success view
    ErrorResult.tsx          # 401/403/404/other error view
    AnalyzeLesson.tsx         # Phase 2: single-lesson trigger, live stage progress, results, download
    CourseTable.tsx            # PR2/UX: summary-only table — search/filter/sort, selection, sticky header
    StatusBadge.tsx              # PR2: job status → badge label/class
    RowActionsMenu.tsx             # UX: compact "•••" overflow menu for less-used row actions
    LessonDetailDrawer.tsx           # UX: [ View ] side drawer — full strategy breakdown + JSON download
    DashboardSummary.tsx               # PR2: course-level stats/spend tiles
    FindWhopUserId.tsx                 # One-time setup: discover your own Whop user id for WHOP_OPERATOR_USER_ID
  App.tsx                 # Orchestrates OAuth (course + diagnostic + identify flows) + display
.github/workflows/deploy.yml  # CI: test backend, test+build+deploy frontend to Pages
backend/                  # Phase 2 Cloud Run backend + Phase 3 course/auth persistence (see backend/README.md)
```

## Documentation this implementation follows

- OAuth 2.1 + PKCE guide: https://docs.whop.com/developer/guides/oauth
- Retrieve course lesson: https://docs.whop.com/api-reference/course-lessons/retrieve-course-lesson
- Permissions/scopes guide: https://docs.whop.com/developer/guides/permissions
- Phase 3 course discovery — `GET /courses/{id}` and the paginated
  `GET /course_lessons?course_id=` — documented in `backend/README.md`

This proof-of-concept intentionally stops at lesson/media discovery. It does
not attempt playback, downloading, or any DRM circumvention.

## Phase 2: Gemini strategy analysis (optional add-on)

A separate backend (in `backend/`, deployed to Google Cloud Run) can take
the same authorized lesson and have Gemini analyze the video to reconstruct
the trading strategy taught in it. See `backend/README.md` for what it does
and its full deployment guide.

To connect this frontend to a deployed backend, set `VITE_BACKEND_URL` at
build time (e.g. as a GitHub Actions repository **variable**, not a secret —
it's just an endpoint URL, not sensitive) to the Cloud Run service URL. If
unset, the frontend works exactly as in Phase 1 and the "Analyze this lesson
with Gemini" section simply doesn't render.

The Whop OAuth access token is still never persisted to localStorage,
sessionStorage, or cookies — it lives only in React state in memory for the
lifetime of the page, and is sent to the backend solely as an
`Authorization: Bearer` header on the one analyze-lesson request.
