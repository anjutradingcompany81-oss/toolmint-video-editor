# ToolMint Video Editor

A browser-based, scene-first video editor: multi-track timeline, non-destructive
editing, and pluggable AI voice-over. Ships at `toolmint.co.in/video-editor`.

**Status: Phase 1 (Foundation) complete; Phase 2 (Core MVP Editor) underway.**
Auth, project CRUD, media upload, and the dashboard are done. The storyboard
editor and a first pass at the multi-track timeline (place/move/trim/split/
delete clips on video and audio tracks) are done. Not yet built: text
overlays, transitions, real-time preview/playback, or FFmpeg rendering. See
the product/systems spec for the full plan (PRD, architecture, DB schema,
timeline JSON format, rendering pipeline, cost/risk, phased plan).

## Stack

- **apps/web** — Next.js (App Router) + TypeScript + Tailwind CSS
- **apps/api** — NestJS + TypeScript + Prisma (PostgreSQL)
- **Infra** — PostgreSQL, Redis (BullMQ later), S3-compatible object storage
  (MinIO locally; swap for AWS S3 / R2 / B2 in production via env vars only)

## Prerequisites

- Node.js 20+
- Docker Desktop (for Postgres / Redis / MinIO)

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

**What's deliberately out of scope for this pass:** text overlays and
transitions (only `clip`/`audio` item types exist so far — the schema's
`type` field is ready to extend), real playback/preview (items reference
`mediaAssetId` but nothing renders video/canvas yet), and real source
duration — `MediaAsset.durationMs` is never populated (no ffprobe
integration yet), so new clips get a placeholder duration (3s for images,
5s for video/audio) with no validation that trims stay within the actual
source length. That validation arrives with the render pipeline.

Verified end to end against live Postgres, including the actual JSON
payload after each operation: added/reordered/renamed/resized scenes;
placed two video clips and one that a locked/wrong-kind track correctly
refused; split a clip at the playhead and confirmed the two halves'
`trimInMs`/`trimOutMs` are exactly complementary; moved a clip via its
start-time field; deleted a clip (and confirmed the confirm-guard actually
blocks an unconfirmed delete); reloaded the page after every step and got
back the exact same state each time.

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
