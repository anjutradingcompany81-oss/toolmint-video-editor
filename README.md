# ProCut Video Editor

A simple, browser-based video editor: upload clips, arrange/trim/split them
on a single timeline, and export one merged MP4. Ships at `toolmint.co.in`
(the app itself is branded ProCut; the domain/hosting predates the rebrand
and was deliberately left in place — see "The ProCut rebuild" below).

**Status: feature-complete for its stated scope.** Upload, drag-reorder,
trim (drag handles or numeric fields), split-at-playhead, delete, undo/redo,
autosave with refresh-safe restore, a continuous sequential preview player,
and export (resolution/quality presets, progress, cancel, download) are all
built and verified end to end against live Postgres/Redis/MinIO, including
on the deployed production stack.

## The ProCut rebuild

This app was rebuilt from an earlier, much more ambitious product
(internally "ToolMint": scenes, multi-track timelines, transitions, text
overlays, clip speed control) into something deliberately narrower. The
brief was explicit: upload/arrange/trim/split/merge/export and nothing
else — no complicated features that distract from those core functions.

**What changed:**
- Data model: `Scene` → `Track` → `TimelineItem` (nested, multi-track)
  replaced by a single flat `Clip[]` array (`Timeline`) — array order *is*
  timeline order.
- Rendering: the old transition/text-overlay-aware FFmpeg filter-graph
  builder was replaced with a much simpler concat-based merge pipeline
  (`apps/api/src/render/merge-ffmpeg.util.ts`) — trim, letterbox to a
  common frame size, concatenate, encode. No transitions, no text.
- Frontend: the scene-list + per-scene multi-track timeline editor was
  replaced with one single-page editor (media panel, preview, timeline,
  properties panel) rebuilt to the color system in "Design system" below.
- Removed entirely: scenes, multi-track compositing, transitions
  (xfade/acrossfade), burned-in text overlays, clip speed control, the
  canvas-based multi-track preview compositor.

**What was deliberately preserved:** the hosting/deployment pipeline —
Docker Compose service/volume/network names, the `toolmint.co.in` domain
and nginx config, the GitHub Actions deploy workflow, the auth/workspace/
media-upload/project-CRUD infrastructure, and the `ProjectVersion`-based
composition persistence pattern (still a validated JSON blob per version,
just a different JSON shape). See "Preserved vs. rebuilt" below for the
exact file-level breakdown.

### Preserved vs. rebuilt

**Preserved as-is:** `deploy/docker-compose.prod.yml`, `deploy/nginx/*.conf`
(except the upload-size ceiling, bumped to match the new 1GB limit — see
below), `.github/workflows/deploy.yml`, both `Dockerfile`s, auth module,
users module, storage module, the `Project`/`Workspace`/`Membership`/
`ProjectVersion`/`AuditLog` Prisma models, the composition
save/autosave/versioning pattern and its route (`/projects/:id/composition`
— same path, new payload shape internally called `Timeline` instead of the
old `Composition`).

**Rebuilt:** `apps/api/src/projects/composition.schema.ts` (flat
`Clip[]`), `apps/api/src/render/*` (new merge pipeline, cancel support,
quality presets), `MediaAsset.hasAudio` (new field, needed for the merge
pipeline's silent-audio fallback), `ExportJob` (dropped `sceneId`, added
`quality`/`outputFileName`/`cancelRequested`), the entire
`apps/web/src/app/dashboard/[projectId]/edit/**` tree, `globals.css`
(new color tokens), the dashboard's New Project flow (no more aspect-ratio
picker — canvas shape is now derived from the first clip at export time).

**Removed (dead code, no longer reachable from any route):**
`apps/api/src/render/ffmpeg-command.util.ts` (+its spec), the old
`apps/web/src/app/dashboard/[projectId]/edit/[sceneId]/**` route (scene
timeline editor), `apps/web/src/app/dashboard/[projectId]/page.tsx` +
`media-upload.tsx`/`media-item.tsx` (a separate project-detail/upload page,
superseded by the new editor's own media panel), unused icon exports, and
the `dejavu-fonts-ttf` npm dependency (only used by the deleted text-overlay
renderer).

## Stack

- **apps/web** — Next.js (App Router) + TypeScript + Tailwind CSS v4
- **apps/api** — NestJS + TypeScript + Prisma (PostgreSQL)
- **Infra** — PostgreSQL, Redis (BullMQ render queue), S3-compatible object
  storage (MinIO locally; swap for AWS S3 / R2 / B2 in production via env
  vars only), FFmpeg (bundled static binary via `ffmpeg-static`/
  `ffprobe-static` — no system install needed, in dev or in the Docker image)

## Design system

Exact palette (`apps/web/src/app/globals.css`, exposed as Tailwind v4
`@theme` tokens — `bg-surface`, `text-ink`, `bg-brand`, etc.):

| Token | Hex | Use |
|---|---|---|
| `surface` | `#090D16` | Main app background |
| `surface-2` | `#101827` | Header, sidebars |
| `panel` | `#162033` | Cards, panels, modals |
| `line` | `#283449` | Borders, dividers |
| `brand` | `#2563EB` | Primary actions, selected clips, active controls |
| `danger` | `#EF4444` | Destructive actions, errors |
| `success` | `#22C55E` | Successful uploads/exports |
| `ink` | `#F8FAFC` | Primary text |
| `ink-muted` | `#94A3B8` | Secondary text |

## Prerequisites

- Node.js 20+
- Docker Desktop (for Postgres / Redis / MinIO) — or WSL2 with Postgres/
  Redis/MinIO installed natively, see "Running infra without Docker" below

## Quick start (development)

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
whatever had a connection open. The fix is to hold the VM open for the
whole dev session:

```bash
# run once, in the background, before starting the API
wsl -d Ubuntu -- sleep infinity &
```

## FFmpeg

No system-level FFmpeg install is required, in dev or in production —
`ffmpeg-static` and `ffprobe-static` (both listed in
`apps/api/package.json`) ship real platform binaries as part of `npm
install`, and both the local dev server and the production Docker image
use those bundled binaries. Verified live in production immediately after
deploy: upload → probe (duration/resolution/audio-track detection) →
merge/export all confirmed working against the actual deployed container.

## Production build & deploy

```bash
npm run build --workspace apps/api   # nest build
npm run build --workspace apps/web   # next build
```

Deployment is CI/CD via GitHub Actions (`.github/workflows/deploy.yml`):
every push to `main` SSHes into the VPS, runs `git pull`, rebuilds the
Docker Compose stack (`docker compose -f deploy/docker-compose.prod.yml
--env-file deploy/.env.prod up -d --build`), and runs `prisma migrate
deploy` inside the API container. Full step-by-step runbook:
**[`deploy/README.md`](deploy/README.md)**.

One manual step outside that automated flow: `deploy/nginx/toolmint.conf`
lives on the VPS's own nginx install, not inside a container, so a change
to it (e.g. the upload-size ceiling bumped in this rebuild) doesn't take
effect from `git pull` alone — copy it to `/etc/nginx/sites-available/`
and `sudo nginx -t && sudo systemctl reload nginx` on the VPS.

## Project structure

```
apps/
  web/    Next.js frontend — dashboard + the ProCut editor
  api/    NestJS backend — REST API, Prisma schema, FFmpeg render pipeline
```

## Scripts (run from repo root)

| Command | What it does |
|---|---|
| `npm run dev:api` / `dev:web` | Run one app in dev mode |
| `npm run build` | Build both apps |
| `npm run lint` | Lint both apps |
| `npm run typecheck` | Type-check both apps |
| `npm run test` | Run tests (API only — 84 tests across 8 suites) |
| `npm run prisma:generate` | Regenerate the Prisma client after a schema change |
| `npm run prisma:migrate` | Create/apply a migration in dev |

## Database

`apps/api/prisma/schema.prisma`: `User`, `Workspace`, `Membership`,
`Project`, `ProjectVersion`, `MediaAsset`, `ExportJob`, `AuditLog`, plus
auth-support tables (refresh tokens, password reset, email verification).

The timeline is never stored as separate rows per clip — it's a single
Zod-validated JSON document on `ProjectVersion.composition`
(`apps/api/src/projects/composition.schema.ts`): `{ schemaVersion, clips:
[{ id, mediaAssetId, trimInMs, trimOutMs, volume, muted }], updatedAt }`.
Array order is timeline order; no separate ordering/position field to keep
in sync.

## Environment variables

See `apps/api/.env.example` and `apps/web/.env.example` for the full list
with comments. Never commit `.env` or `.env.local` — both are gitignored.

Key ones:

| Variable | Where | What |
|---|---|---|
| `DATABASE_URL` | api | Postgres connection string |
| `REDIS_URL` | api | Redis connection string (BullMQ render queue) |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | api | S3-compatible object storage (MinIO locally) |
| `JWT_ACCESS_SECRET` | api | Signs access tokens |
| `WEB_APP_URL` | api | CORS origin + link base for auth emails |
| `NEXT_PUBLIC_API_URL` | web | API base URL the browser calls |

## Auth

Email/password auth, backed by short-lived JWT access tokens and rotating
opaque refresh tokens; guest login also available (private, per-session
accounts, no sign-up).

| Endpoint | What it does |
|---|---|
| `POST /auth/register` | Create a user + a default personal workspace, log in immediately |
| `POST /auth/login` | Exchange email/password for tokens |
| `POST /auth/guest` | Create a private guest account, log in immediately |
| `POST /auth/refresh` | Rotate the refresh token (cookie-based), issue a new access token |
| `POST /auth/logout` | Revoke the current refresh token |
| `GET /auth/me` | Current user |
| `POST /auth/verify-email` / `resend-verification` | Email verification |
| `POST /auth/forgot-password` / `reset-password` | Password reset |

## Projects & media

| Endpoint | What it does |
|---|---|
| `POST /projects` | Create a project (`{ title, fps? }` — no aspect-ratio picker; canvas shape is derived from the first clip at export time) |
| `GET /projects?includeArchived=&search=` | List the caller's projects |
| `GET /projects/:id` / `PATCH` / `DELETE` / `POST /:id/duplicate` | Standard CRUD |
| `POST /projects/:id/media` | Upload a video (`multipart/form-data`, field `file`) |
| `GET /projects/:id/media` | List a project's media, each with a signed preview URL |
| `DELETE /projects/:id/media/:mediaAssetId` | Delete one media asset |

Notes:
- Video only (MP4/MOV/WebM/AVI/MKV), 1GB per file
  (`apps/api/src/media/media.constants.ts`). Duplicate uploads are
  rejected by SHA-256 checksum.
- Each upload is probed with ffprobe for duration, resolution, and whether
  it has an audio track (`MediaAsset.hasAudio`) — the merge pipeline
  generates a silent audio segment for sources with none, rather than
  erroring or desyncing the timeline.
- Filenames are sanitized before ever touching a storage key or shell
  command — no path traversal, no injection.

## Composition & editor

| Endpoint | What it does |
|---|---|
| `GET /projects/:id/composition` | The latest saved timeline |
| `POST /projects/:id/composition` | Validate and save — creates a new `ProjectVersion` row |

`/dashboard/[projectId]/edit` is the whole editor: a media panel (upload,
thumbnails, add-to-timeline) on the left, a preview player in the center
(continuous playback across clip boundaries, play/pause, frame-step,
scrub, per-clip volume/mute, fullscreen), a single timeline along the
bottom (drag to reorder, drag the clip edges to trim, split at the
playhead, delete, zoom, magnetic snapping to clip boundaries and the
playhead), and a properties panel on the right (numeric trim, volume,
mute, reset, delete). Autosave debounces ~1.5s after the last edit; a
refresh restores the last-saved state (verified live — mid-edit reload
returns the exact same clip list).

Keyboard shortcuts: Space (play/pause), S (split), Delete/Backspace
(remove selected), Ctrl/Cmd+Z (undo), Ctrl/Cmd+Shift+Z (redo), ←/→ (step
one frame), Ctrl/Cmd +/− (zoom). A shortcut only fires when focus isn't in
a genuine text-entry control — a range slider or checkbox holding focus
(e.g. right after dragging the volume slider) doesn't block Space/S/etc.

## Rendering & export

| Endpoint | What it does |
|---|---|
| `POST /projects/:id/exports` | Start a render — `{ resolution: "R720P" \| "R1080P" \| "ORIGINAL", quality?: "STANDARD" \| "HIGH" \| "MAXIMUM", outputFileName? }` |
| `GET /projects/:id/exports` | List a project's export jobs |
| `GET /projects/:id/exports/:jobId` | Poll one job; includes a signed download URL once `COMPLETED` |
| `POST /projects/:id/exports/:jobId/cancel` | Request cancellation of a queued/running export |

Architecture: `POST` creates an `ExportJob` row and enqueues it on a
BullMQ queue backed by Redis; only one export can be active per project at
a time (a second request is rejected, not silently queued behind the
first, so the UI never looks like it's doing nothing). An in-process
worker (`RenderProcessor`) downloads each clip's source from object
storage, builds a single FFmpeg `filter_complex` graph
(`merge-ffmpeg.util.ts`) that trims each clip to its playable span, scales
and pads every clip to the first clip's own aspect ratio (letterboxed, not
stretched), and concatenates with a single interleaved
`concat=n=N:v=1:a=1` filter — no transitions, no per-clip effects, matching
the "hard cuts only" scope. Quality presets map to CRF/audio-bitrate pairs
(`STANDARD`: crf 23/128k, `HIGH`: crf 20/192k, `MAXIMUM`: crf 16/256k).
Cancellation is real, not cosmetic: the worker polls the job's
`cancelRequested` flag once a second while ffmpeg runs and sends `SIGTERM`
if it's set — verified live with a 25-second 1080p source, cancelling
mid-render and confirming the job actually stopped (status flips to
`CANCELLED`) rather than running to completion regardless.

**Verified end to end, twice** — once against local dev infra, once
against the actual deployed production stack immediately after this
rebuild went live: upload two real clips (one with audio, one without,
different resolutions) → trim one → split another into two independently
editable segments → export → `ffprobe` the downloaded output. Confirmed:
correct total duration (sum of trimmed/split segments, exactly), correct
canvas dimensions with letterboxing for the mismatched-resolution clip,
continuous AAC audio across the whole output including through the
segment that had no source audio (synthetic silent track), and a
standards-compliant H.264/AAC/yuv420p MP4 with `faststart` that plays in
any common player.

## Known limitations

- **No chunked/resumable upload.** Uploads are a single multipart POST,
  proxied through the API (not a direct browser→bucket presigned PUT).
  Fine up to the 1GB ceiling on a stable connection; a dropped connection
  mid-upload has to restart from zero. Chunked/resumable upload (tus
  protocol, or S3 multipart) would be the next step if large files on
  unreliable connections becomes a real requirement.
- **No malware/content scanning** on uploads — type/size/duplicate
  validation only.
- **Progress during render is coarse-grained**, not frame-accurate: it's
  driven by parsing ffmpeg's own `time=` stderr lines against the known
  total duration, updated at most twice a second — smooth enough for a
  progress bar, not a precise ETA.
- **Thumbnails aren't auto-generated** for exported videos or for
  individual media assets beyond the browser's own first-frame video
  poster — `Project.thumbnailKey` exists in the schema (fed by a captured
  preview frame elsewhere in the app) but nothing auto-populates it from
  an uploaded clip yet.
- **Mobile is functional but not optimized.** The editor lays out with
  fixed-width side panels sized for desktop; it works down to a tablet
  viewport but doesn't yet collapse into the "recommend desktop for
  advanced editing" mobile-specific flow the original spec called for.

## Testing

Backend: 84 tests across 8 suites (`npm run test --workspace apps/api`),
covering the merge/trim/split FFmpeg command builder in isolation (no real
ffmpeg process — pure function tests on the generated argument list), plus
service-level tests for auth, projects, media (including duplicate-upload
rejection and the video-only file-type restriction), composition
validation, and the export service (including the single-active-export
guard and cancel flow).

No automated frontend test suite yet — verified instead by driving the
actual browser against real infra (both local dev and, after deploy, the
live production stack): registration/login/guest-login, project creation,
upload, add-to-timeline, playback across clip boundaries, trim (drag
handles and numeric fields), split, drag-to-reorder, delete, undo/redo,
every keyboard shortcut (via real trusted key events, not synthetic
`dispatchEvent` — browser autoplay policy blocks `.play()` from untrusted
synthetic events, which surfaced as a useful reminder while verifying
Space-to-play), export with live progress, cancel-mid-render, and a
refresh-mid-edit restore. Two real bugs were found and fixed this way: an
export-cancel request that updated the database flag but never actually
signaled the running ffmpeg process, and a keyboard-shortcut guard that
was too broad (blocking Space/S/Delete/etc. whenever *any* `<input>` —
including the playhead scrubber and volume slider — held focus, not just
genuine text-entry fields).

## Deploying to production

Runs as a self-contained Docker Compose stack on a VPS, isolated from
anything else already on that machine (own network, own volumes, own
containers — see `deploy/docker-compose.prod.yml`'s header comment) with
nginx as the single public entry point for `www.toolmint.co.in` (web),
`api.toolmint.co.in` (API + its in-process BullMQ render worker), and
`media.toolmint.co.in` (S3-compatible storage, self-hosted via MinIO).

Full step-by-step runbook: **[`deploy/README.md`](deploy/README.md)**.

The one non-obvious thing worth knowing going in: the refresh-token cookie
is `SameSite=Lax`, which is sent on a cross-*origin* fetch as long as both
sides share a registrable domain — `www.` and `api.` under `toolmint.co.in`
qualify, so this only works because the API gets a real subdomain rather
than being reachable by IP or a different domain entirely.
