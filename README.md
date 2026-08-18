# ToolMint Video Editor

A browser-based, scene-first video editor: multi-track timeline, non-destructive
editing, and pluggable AI voice-over. Ships at `toolmint.co.in/video-editor`.

**Status: Phase 1 (Foundation) complete; Phase 2 (Core MVP Editor) complete.**
Auth, project CRUD, media upload, and the dashboard are done. The storyboard
editor, the multi-track timeline (place/move/trim/split/delete clips),
rendering (export a scene to a real MP4), a real-time canvas preview player
(play/pause/scrub what's actually on the timeline), text overlays (added,
styled, and burned into the export via FFmpeg's drawtext), and transitions
(crossfade/wipe/slide between clips, both previewed and actually rendered
via xfade/acrossfade) are done. See the product/systems spec for the full
plan (PRD, architecture, DB schema, timeline JSON format, rendering
pipeline, cost/risk, phased plan) and Phase 3+ scope.

## Stack

- **apps/web** — Next.js (App Router) + TypeScript + Tailwind CSS
- **apps/api** — NestJS + TypeScript + Prisma (PostgreSQL)
- **Infra** — PostgreSQL, Redis (BullMQ render queue), S3-compatible object
  storage (MinIO locally; swap for AWS S3 / R2 / B2 in production via env
  vars only), FFmpeg (bundled static binary — no system install needed)

## Prerequisites

- Node.js 20+
- Docker Desktop (for Postgres / Redis / MinIO) — or WSL2 with Postgres/
  Redis/MinIO installed natively, see "Running infra without Docker" below

## Quick start

```bash
npm install

# Copy env files and fill in local values (defaults already match docker-compose.yml)
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# Start Postgres, Redis, MinIO
docker compose up -d

# Apply the database schema
npm run prisma:migrate

# Run both apps (separate terminals)
npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:3000
```

Open `http://localhost:3000` — it live-checks connectivity to the API. `/health`
on the API confirms the database connection.

> **Note:** if another project on this machine already binds 5432/6379/3000,
> Postgres/Redis (docker-compose.yml) or the dev server will shift ports
> automatically or need remapping — update `DATABASE_URL` / `REDIS_URL` /
> `WEB_APP_URL` in `apps/api/.env` to match.

## Running infra without Docker

Docker Desktop is unreliable on this machine (`com.docker.backend.exe`
crashes on launch with `exit status 150`, a WSL2/virtualization-layer
failure). Postgres 18, Redis 8, and MinIO run natively inside WSL2's
Ubuntu distro instead, as systemd services, reachable from Windows at
`127.0.0.1:5433` / `127.0.0.1:6380` / `127.0.0.1:9000` (remapped off the
defaults to not collide with another project on this machine — see
`apps/api/.env`).

**The one thing that matters if you use this setup: keep a long-lived WSL
process running whenever the API is running.** WSL2's lightweight VM shuts
itself down a few seconds after the last attached process exits, and the
*next* `wsl` invocation silently reboots it from scratch — which restarts
every systemd service inside, including Postgres/Redis/MinIO, killing
whatever had a connection open. This looked exactly like flaky networking
(intermittent `ECONNREFUSED` / `P1001 Can't reach database server`) and
cost a lot of time to diagnose as VM churn instead. The fix is to hold the
VM open for the whole dev session:

```bash
# run once, in the background, before starting the API
wsl -d Ubuntu -- sleep infinity &
```

With that running, the WSL VM (and everything in it) stays up indefinitely
and the API's Postgres/Redis connections stay alive normally — no
special retry logic needed. Without it, expect the API to work for the
first request or two after each `wsl` command and then start throwing
connection errors as the VM tears itself down again.

## Project structure

```
apps/
  web/    Next.js frontend — public site + editor UI (Phase 2+)
  api/    NestJS backend — REST/GraphQL API, Prisma schema, business logic
```

Additional apps (render workers, AI workers) are split out from `apps/api` once
Phase 2/3 makes rendering and AI generation heavy enough to need independent
scaling — see the architecture doc.

## Scripts (run from repo root)

| Command | What it does |
|---|---|
| `npm run dev:api` / `dev:web` | Run one app in dev mode |
| `npm run build` | Build both apps |
| `npm run lint` | Lint both apps |
| `npm run typecheck` | Type-check both apps |
| `npm run test` | Run tests (API only, for now) |
| `npm run prisma:generate` | Regenerate the Prisma client after a schema change |
| `npm run prisma:migrate` | Create/apply a migration in dev |

> **Note:** on this machine (Windows, project under a OneDrive-synced path),
> Jest's file crawler has intermittently under-reported `apps/api/src` —
> `jest --listTests` silently returning only a handful of files (always the
> ones most recently written) instead of every `*.spec.ts` file, with no
> error. Ruled out: stale cache (`--clearCache` and a fresh
> `--cacheDirectory` didn't help), Watchman (not installed), file or
> directory mtime (touching either didn't help), and the Jest major version
> (pinning `jest`/`ts-jest`/`@types/jest` to `^29` instead of `latest`
> didn't help either). The only fix found was re-writing each missing
> spec file's content. Root cause unconfirmed — if `npm test` ever reports
> suspiciously few suites, run `jest --listTests` before trusting a clean
> result, and re-save any spec file that's missing.

## Database

The schema (`apps/api/prisma/schema.prisma`) currently covers what Phase 1
needs: `User`, `Workspace`, `Membership`, `Project`, `ProjectVersion`,
`MediaAsset`, `AuditLog`, plus auth-support tables (refresh tokens, password
reset, email verification). `Scene` / `Track` / `TimelineItem` / `VoiceOver` /
`ExportJob` / etc. are added when the editor and AI modules that own them are
built, not before — see the DB schema section of the spec for the full model.

The timeline itself is never stored as separate rows per clip — it's a single
validated JSON document on `ProjectVersion.composition`, checked against the
Zod schema in `apps/api/src/projects/composition.schema.ts`. See the spec's
"Timeline JSON specification" for the format.

## Auth

Email/password auth, backed by short-lived JWT access tokens and rotating
opaque refresh tokens:

| Endpoint | What it does |
|---|---|
| `POST /auth/register` | Create a user + a default personal workspace, log in immediately |
| `POST /auth/login` | Exchange email/password for tokens |
| `POST /auth/refresh` | Rotate the refresh token (cookie-based), issue a new access token |
| `POST /auth/logout` | Revoke the current refresh token |
| `GET /auth/me` | Current user (requires `Authorization: Bearer <accessToken>`) |
| `POST /auth/verify-email` | Consume a verification token |
| `POST /auth/resend-verification` | Re-send the verification email (requires auth) |
| `POST /auth/forgot-password` | Request a reset link (always 200 — never reveals whether the email exists) |
| `POST /auth/reset-password` | Consume a reset token, set a new password, revoke all sessions |

Notes:
- The access token comes back in the JSON body; the refresh token is set as an
  `httpOnly` cookie scoped to `/auth`, never exposed to client JS.
- Refresh tokens rotate on every use. Replaying an already-rotated token is
  treated as theft and revokes every active session for that user.
- Registration issues tokens immediately — email verification is required
  before certain future actions (not yet gated on anything), not before login.
- Verification/reset emails go through a `MailService` adapter; the dev
  implementation logs the message (with the link) to the API console instead
  of sending real email. Swap in a real provider by implementing `MailService`
  and changing the provider in `apps/api/src/mail/mail.module.ts`.
- `register`, `login`, `forgot-password`, and `resend-verification` are rate
  limited per IP (in-memory — fine for one API instance; move to a
  Redis-backed limiter before running more than one).

## Projects & media

All endpoints below require `Authorization: Bearer <accessToken>`.

| Endpoint | What it does |
|---|---|
| `POST /projects` | Create a project (+ its initial empty composition) in the caller's workspace |
| `GET /projects?includeArchived=&search=` | List the caller's projects, newest-updated first |
| `GET /projects/:id` | Get one project (404, not 403, if the caller isn't a member) |
| `PATCH /projects/:id` | Rename and/or archive/unarchive |
| `POST /projects/:id/duplicate` | Clone a project, including its latest composition |
| `DELETE /projects/:id` | Delete a project and its media objects |
| `POST /projects/:id/media` | Upload a file (`multipart/form-data`, field `file`) |
| `GET /projects/:id/media` | List a project's media, each with a 10-minute signed preview URL |
| `DELETE /projects/:id/media/:mediaAssetId` | Delete one media asset |

Notes:
- Workspace roles gate write access: `VIEWER`/`REVIEWER` can read but not
  rename, archive, delete, or upload; `OWNER`/`EDITOR` can do both. Every user
  is `OWNER` of their own workspace today — role differences matter once team
  workspaces (Phase 4) exist.
- Uploads are proxied through the API (multipart in, `PutObject` out) rather
  than a direct browser-to-bucket presigned PUT. That's simpler and sidesteps
  bucket CORS entirely, at the cost of routing file bytes through the Node
  process — fine at MVP scale, worth revisiting (direct presigned uploads,
  chunked/resumable) before large files or high volume matter.
- Per-kind mime-type allowlist and size caps live in
  `apps/api/src/media/media.constants.ts` (video 500MB, image 25MB, audio
  100MB, PDF 20MB) — placeholders until plan-based limits exist.
- No malware scanning yet (Phase 4/5 concern per the spec) — only type/size
  validation today.

## Composition & editor

| Endpoint | What it does |
|---|---|
| `GET /projects/:id/composition` | The latest saved composition (scenes, tracks, etc.) |
| `POST /projects/:id/composition` | Validate and save — creates a **new** `ProjectVersion` row, doesn't mutate one in place |

Autosave creates a new version per save rather than updating one in place.
That matches the spec (composition JSON lives on an immutable
`ProjectVersion` snapshot) and makes "restore an earlier version" (Phase 4)
a read over rows that already exist instead of a schema change later. At
MVP save frequency (debounced ~1.5s after the last edit) this is a
reasonable number of rows; if that changes, a scheduled job to prune/squash
old autosave versions is the fix — not switching to in-place mutation.

`/dashboard/[projectId]/edit` is the storyboard editor: add/rename/reorder
(move up/down)/delete scenes, per-scene duration.

`/dashboard/[projectId]/edit/[sceneId]` is the timeline editor for one
scene: add video/audio tracks (lock/mute/remove), select a media asset and
click a track to append it there, select a placed clip to edit its start/
duration as precise numbers, split it at the playhead (click the ruler to
move the playhead), and delete (confirmed — no undo system yet). A track
only accepts compatible media (video tracks take video/image, audio tracks
take audio), enforced both as a disabled/labeled affordance in the UI and
by the Zod schema server-side.

Both editors debounce saves and show status (`Unsaved changes` → `Saving…`
→ `Saved`, or an error), sharing one hook (`use-composition-editor.ts`) so
neither duplicates the load/autosave logic.

**Why click-to-place instead of drag-and-drop, and number fields instead of
drag-to-trim:** this codebase already prefers explicit controls over drag
gestures (scene reordering uses move-up/down buttons, not drag) — for the
same reason it does here: precise, keyboard/screen-reader friendly, and
reliably testable, versus a native HTML5 drag-and-drop or freeform
pointer-drag interaction that's fragile to automate and awkward on touch.
Real drag-and-drop placement and drag-to-trim handles are UX polish that
can be layered on top of the same data model later without a rework.

**What's deliberately out of scope for this pass:** transitions (`clip`/
`audio`/`text` item types exist — see "Text overlays" below — but nothing
for cross-fades or wipes between clips yet), and real source duration —
`MediaAsset.durationMs` is never populated (no ffprobe integration yet),
so new clips get a placeholder duration (3s for images, 5s for video/audio)
with no validation that trims stay within the actual source length. That
validation arrives with the render pipeline.

Verified end to end against live Postgres, including the actual JSON
payload after each operation: added/reordered/renamed/resized scenes;
placed two video clips and one that a locked/wrong-kind track correctly
refused; split a clip at the playhead and confirmed the two halves'
`trimInMs`/`trimOutMs` are exactly complementary; moved a clip via its
start-time field; deleted a clip (and confirmed the confirm-guard actually
blocks an unconfirmed delete); reloaded the page after every step and got
back the exact same state each time.

## Preview player

`scene-preview.tsx` renders what's actually on the timeline — a `<canvas>`
above the track list with Play/Pause and a time readout, sharing the same
`playheadMs` state as the ruler (so scrubbing the ruler moves the preview
and vice versa). It mirrors the renderer's own scope: the first video track
with clips (image or video) plus the first audio track with clips, same as
what `POST /exports` will actually render — what you preview is what you
get.

Video/image/audio elements are created lazily (one per `MediaAsset`, kept
off-DOM, `drawImage`'d onto the canvas each frame) rather than one element
per timeline item, so scrubbing back onto a clip reuses its already-loaded
element instead of re-fetching. Playback drives the active element's
native `play()` (so decoding/audio timing stays smooth) and only reseeks
on clip changes or when drift exceeds 300ms, rather than reseeking every
animation frame — reseeking every frame is the naive approach and it
stutters badly on compressed video. Paused scrubbing seeks directly and
redraws once the browser fires `seeked`/`loadeddata` — necessary because
the very first `drawImage` after creating an element usually fires before
it has a decoded frame at all, drawing nothing.

`Transform` (x/y/scale/rotation/opacity, already in the schema, previously
unused) is applied on the canvas the same way it will need to be applied
in the render pipeline eventually: fit-contain into the frame, then the
clip's own scale/offset/rotation/opacity on top.

**Known limitation:** video/image elements are loaded from MinIO's signed
URLs, a different origin than the web app, and MinIO doesn't send CORS
headers — so the canvas is "tainted" after the first `drawImage`
(`getImageData`/`toDataURL` throw `SecurityError`). Display-only playback
is unaffected; anything that needs pixel readback (e.g. generating a
thumbnail from the canvas) will need CORS headers added to the MinIO
bucket policy first.

Verified live: uploaded a real synthetic clip, placed it on a video track,
confirmed the canvas actually painted its color (not just a black frame —
caught and fixed a real bug this way, see the "Known limitation" note's
sibling fix above about `seeked`/`loadeddata`), pressed Play and watched
the readout and the ruler's playhead advance in lockstep, confirmed
playback auto-stops at exactly the scene's end, and confirmed clicking the
ruler while paused scrubs the canvas to the correct frame.

## Text overlays

A `text` track type holds `text`-type timeline items — no `MediaAsset`
behind them; content/font size/color live directly on the item
(`composition.schema.ts`'s `timelineItemSchema` is a Zod discriminated
union on `type` now: `clip`/`audio` items are still backed by a
`mediaAssetId`, `text` items aren't). Add a text track from the timeline
editor's Tracks panel, then click its lane to append a default item —
selecting it shows Text/Font size/Color fields alongside the usual Start/
Duration. Unlike video/audio tracks, a scene can have any number of text
tracks and their items never need to be contiguous or non-overlapping —
overlapping captions/titles are meant to stack.

**Rendered for real, not just a UI mockup:** the render pipeline chains a
`drawtext` filter per active text item onto the video output
(`ffmpeg-command.util.ts`), gated by `enable='between(t,start,end)'` so
each one is only visible during its own time range. Two choices worth
calling out:
- **Font:** bundled via the `dejavu-fonts-ttf` npm package (dependency-
  free, ships real `.ttf` files) rather than relying on whatever fonts
  happen to be on the host — matters most on a bare Linux prod server,
  which usually has none.
- **Text content goes through a file (`textfile=`), not inlined into the
  filter string.** FFmpeg drawtext's inline-text escaping rules (colons,
  quotes, percent signs each need different treatment) are fragile enough
  that a temp `.txt` file per overlay was the more correct choice — only
  the file *path* needs escaping (Windows drive-letter colons,
  backslashes), not arbitrary user-typed content.

**Known limitation, deliberate:** rotation isn't editable for text, in
either the preview or the export. FFmpeg's `drawtext` filter has no
rotation option — supporting it in the editor would mean preview and
export could visibly disagree, which is worse than not having it.

Verified live end to end: added a text track and item through the actual
UI, edited content/font size/color, confirmed the saved composition
matches server-side, confirmed the canvas preview paints the text in the
right color/content, exported the scene, downloaded the real output MP4,
and extracted a frame with `ffmpeg` — the text is genuinely burned into
the video, not just visible in the editor.

## Rendering & export

| Endpoint | What it does |
|---|---|
| `POST /projects/:id/exports` | Start a render — body `{ sceneId, resolution: "R720P" \| "R1080P" }` |
| `GET /projects/:id/exports` | List a project's export jobs, newest first |
| `GET /projects/:id/exports/:jobId` | Poll one job; includes a signed download URL once `COMPLETED` |

Architecture: `POST` creates an `ExportJob` row (`QUEUED`) and enqueues it on
a BullMQ queue backed by Redis. An in-process worker (`RenderProcessor`,
started alongside the API — a separate worker process is a scaling
concern for later, not a correctness one now) picks it up, downloads the
needed source files from object storage to a temp directory, builds an
FFmpeg `filter_complex` graph, runs a real FFmpeg process (via
`ffmpeg-static` — a bundled binary, no system install required; see the
note in "Transitions" below on why this isn't `@ffmpeg-installer/ffmpeg`
anymore), uploads the result back to object storage, and updates the job
to `COMPLETED` with a storage key (or `FAILED` with a message). Progress
is coarse-grained (stage-based: 5/15/40/90/100), not frame-accurate.

**Scope for this pass:** renders one scene at a time (not a whole
multi-scene project), from exactly one video track plus at most one audio
track — plus *every* text track's items (text is meant to layer over the
video, so unlike clips it isn't limited to one track and doesn't need to
be contiguous; see "Text overlays" above). Multiple video/audio tracks
(which would need real layering/compositing, not built yet) are ignored
beyond the first of each. Clips on the rendered video/audio track must be
back-to-back with **no gaps** — the render is rejected up front with a
specific, actionable message (`ffmpeg-command.util.ts`'s
`checkContiguous`) rather than silently producing wrong output; a bounded
*overlap*, however, is no longer an error — see "Transitions" below.
Output resolution is derived from the project's aspect ratio and the
chosen 720p/1080p tier (`computeDimensions`); images are looped to their
placed duration, videos are trimmed per clip, and everything is
scaled/padded to a common frame size before concatenation so mixed source
resolutions don't break the concat filter.

Code, unit tests (dimension math, contiguity validation, filter-graph,
text-overlay drawtext-chain, and transition xfade/acrossfade-chain
construction, Windows path escaping — 25 tests), typecheck, lint, and
build are all verified.
Verified end to end twice against live Postgres/Redis/MinIO: once via raw
API calls (register, create a project, upload two real FFmpeg-generated
clips, place them back-to-back on a track, export, poll to `COMPLETED`,
download, `ffprobe` the output) and once by driving the actual browser UI
(register, upload through the drop zone, add a track, place a clip, click
"Export scene", watch the panel go `Queued` → `Ready` with a working
download link). Both produced a genuine playable H.264 MP4 at the
requested resolution and duration. The failure path was verified for
free along the way: an export attempted against a since-changed
composition correctly failed with `This scene has no video clips to
render` instead of producing wrong output. See "Running infra without
Docker" below for what made this fiddly on this machine.

## Transitions

No new field stores a transition's *duration* — it's simply however far a
clip's `startMs` overlaps the previous clip's end on the same track.
`checkContiguous` (`ffmpeg-command.util.ts`) used to reject any overlap;
now it only rejects a *gap*, or an overlap long enough to consume one of
the two clips entirely (nothing left to actually show). The only new
field is `transitionIn` on clip/audio items — a style (`fade`/`wipeleft`/
`wiperight`/`slideup`), meaningless until an overlap exists. To create a
transition in the timeline editor: place two clips back-to-back, then
drag/type the second one's Start (s) earlier so it overlaps the first,
and pick a style from the "Transition in" dropdown that appears on
selection.

**Rendered for real:** when a track has an overlap, the renderer chains
`xfade` (video) / `acrossfade` (audio) instead of `concat`, computing each
transition's `offset` from the running cumulative duration of the
merged-so-far stream (each transition shrinks that running total by its
own length — not just the sum of raw clip durations). No transition on a
track falls back to the exact same `concat` path as before, so untouched
projects render identically to pre-transition behavior.

**A real blocker hit and fixed along the way:** `xfade` requires FFmpeg
4.3+, but `@ffmpeg-installer/ffmpeg` (used since the render module was
first built) turned out to be a frozen 2018 build with no newer version
ever published — there was no "wait for an update" path. Rather than
hand-roll a crossfade from 2018-era filters (`overlay`+`fade`+`tpad`
timeline-shifting — doable, but fragile and a lot more filter-graph
surface area to get subtly wrong), the render pipeline now runs on
`ffmpeg-static` instead (FFmpeg 6.1, confirmed via `-filters` to actually
have `xfade`/`acrossfade`), which changes nothing about the "bundled
binary, no system install" property — it's a different package, not a
system dependency.

**Preview parity, and where it deliberately falls short:** the canvas
preview blends two active clips during their overlap window — the
incoming clip is drawn over the outgoing one with `globalAlpha` rising
from 0 to 1, which is mathematically the same result as a linear
crossfade for opaque video frames. Audio gets a real crossfade too
(`HTMLAudioElement.volume` on both elements, no Web Audio API needed).
**Known limitation:** only the `fade` style is actually blended in
preview — `wipeleft`/`wiperight`/`slideup` are approximated as a hard cut
at the overlap's midpoint, since reproducing FFmpeg's exact wipe/slide
geometry in canvas wasn't worth the complexity for a preview (the export
always renders the real style regardless).

Verified live end to end: two real FFmpeg-generated clips (solid blue,
solid green) placed with a 1s overlap and `transitionIn: "fade"`,
confirmed the schema accepted the overlap (previously would have been
rejected), exported the scene, downloaded the real output, and extracted
frames across the transition window with `ffmpeg` — pure blue before the
overlap, a genuine blue-green blend at the midpoint, pure green after,
confirming an actual gradient rather than a hard cut. The same blend was
also confirmed live in the browser preview by scrubbing into the overlap.

## Frontend

`apps/web/src/lib` holds the client-side data layer:

- `api-client.ts` — `apiFetch()` wraps every API call: attaches the in-memory
  access token, and on a 401 transparently refreshes and retries once.
  `refreshSession()` is the single entry point for calling `/auth/refresh` —
  concurrent callers (a 401 retry racing the initial mount-time session
  restore, or React invoking an effect twice) dedupe onto one in-flight
  request. This isn't optional: refresh tokens rotate on every use, and the
  API treats a replayed token as theft by revoking every session for that
  user — two concurrent, undeduped refresh calls from the same starting
  cookie will lock the user out. (Found and fixed via live browser testing,
  not something the unit tests catch.)
- `auth-context.tsx` — `AuthProvider`/`useAuth()`. Access token lives in
  memory only (not localStorage); a page load has none, so it restores the
  session via the refresh cookie on mount.
- `use-require-auth.ts` — redirects to `/login` when unauthenticated; used by
  every page under `/dashboard`.
- `projects-api.ts` — typed wrappers for the Projects/Media endpoints.

Pages: `/login`, `/register`, `/forgot-password`, `/reset-password`,
`/verify-email`, `/dashboard` (list/create/rename/archive/duplicate/delete),
`/dashboard/[projectId]` (drag-and-drop or click-to-browse upload, media
grid with type-appropriate previews). No tests yet for `apps/web` — verified
by live browser walkthrough (register → create → rename → duplicate →
archive/filter → upload → delete-confirmation → logout) against the real API,
Postgres, and MinIO.

## Environment variables

See `apps/api/.env.example` and `apps/web/.env.example`. Never commit `.env` or
`.env.local` — both are gitignored.

## Deploying to production

Target stack: **Vercel** (web), **Railway** (API + its BullMQ render worker,
in-process — see "Rendering & export"), **Neon** (Postgres), **Railway Redis**
(not Upstash — BullMQ needs blocking commands some serverless-Redis tiers
restrict; Railway's Redis is co-located with the API and has no such
caveat), **Cloudflare R2** (object storage, S3-compatible, no egress fees).
Nothing in the code is tied to these specific providers — `StorageService`
talks to whatever's behind `S3_ENDPOINT`, and Postgres/Redis are just
connection strings — swap any of them for AWS/GCP/a VPS without code changes.

Domain layout: `www.toolmint.co.in` (web, on Vercel) and
`api.toolmint.co.in` (API, on Railway) — **the subdomain split matters**,
not just naming: the refresh-token cookie is `SameSite=Lax`, which is sent
on cross-*origin* fetches as long as they're same-*site* (same registrable
domain). `www.` and `api.` under `toolmint.co.in` qualify; a raw
`*.up.railway.app` API URL would not, and login would silently fail to
persist. If you don't want a custom API subdomain, change the cookie's
`sameSite` to `"none"` in `auth.controller.ts` instead (`secure: true` is
already conditional on `NODE_ENV=production`, which `none` requires).

**1. Neon (Postgres)** — create a project, copy its pooled connection
string into `DATABASE_URL` (append `?sslmode=require` if Neon doesn't add
it already).

**2. Cloudflare R2 (storage)** — create a bucket, an API token scoped to
it, and note the account's S3 endpoint
(`https://<account_id>.r2.cloudflarestorage.com`). Maps directly to
`S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` /
`S3_BUCKET`; set `S3_REGION=auto` and `S3_FORCE_PATH_STYLE=true`.

**3. Railway (API + Redis)**
- New project → add a **Redis** service (gives you `REDIS_URL` automatically
  — copy it into the API service's env instead of wiring a reference, simpler
  to reason about).
- Add a service from this GitHub repo, **root directory `apps/api`**.
  Railway auto-detects the Node build; `postinstall` runs `prisma generate`
  automatically as part of `npm install`, and `npm run build` runs `nest
  build`. Start command: `npm run start`.
- Env vars: `NODE_ENV=production`, `DATABASE_URL` (from Neon),
  `REDIS_URL` (from Railway's Redis service), the `S3_*` vars (from R2),
  `WEB_APP_URL=https://www.toolmint.co.in`, a freshly generated
  `JWT_ACCESS_SECRET` (`openssl rand -base64 48` — **not** the dev
  placeholder), `JWT_ACCESS_TTL=15m`, `JWT_REFRESH_TTL=30d`. Leave `PORT`
  unset — Railway injects it, and `main.ts` already prefers it over
  `API_PORT`.
- Before (or right after) the first deploy, run the migration against the
  Neon database once: `DATABASE_URL=<neon-connection-string> npm run
  prisma:deploy` (from `apps/api`, locally or via Railway's shell) — **not**
  `prisma:migrate`, which is the interactive dev command and will prompt.
- Add the custom domain `api.toolmint.co.in` in Railway's service settings,
  and the CNAME it gives you at your DNS registrar.

**4. Vercel (web)**
- Import the repo, set the project's **Root Directory** to `apps/web`
  (Vercel's standard flow for an npm-workspaces monorepo — it still runs
  `npm install` at the repo root, then builds within that directory).
- Env var: `NEXT_PUBLIC_API_URL=https://api.toolmint.co.in`. This is
  inlined at *build* time (it's `NEXT_PUBLIC_`), so set it before the first
  deploy, not after.
- Add `www.toolmint.co.in` as the project's domain; add `toolmint.co.in`
  (apex) too and let Vercel redirect it to `www` (its domain settings do
  this without extra config) so both resolve.
- At your DNS registrar: a `CNAME` (or Vercel's given `A`/`ALIAS` record)
  for `www` → Vercel, and whatever apex-domain record Vercel's domain
  panel asks for.

**5. Before real users touch it:** `MailService`'s only implementation
today logs verification/reset emails to the console (see "Auth" above) —
those emails go nowhere a user can see them. Implement a real provider
(Postmark/Resend/SES — anything behind the same `MailService` interface)
before launch, or password reset and email verification will silently not
work for anyone.

**Verifying the deploy:** `https://api.toolmint.co.in/health` should return
`{"status":"ok",...}` (confirms Postgres connectivity); then register a
real account at `https://www.toolmint.co.in`, upload a real clip, and
export a scene — a `FAILED` export with a real error message beats a
silent gap, so check the export panel, not just that the page loads.
