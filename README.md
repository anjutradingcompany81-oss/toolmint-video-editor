# ToolMint Video Editor

A browser-based, scene-first video editor: multi-track timeline, non-destructive
editing, and pluggable AI voice-over. Ships at `toolmint.co.in/video-editor`.

**Status: Phase 1 (Foundation) in progress.** This repo currently contains the
monorepo scaffold, database schema, and a health-checked API ↔ web connection —
not yet auth, the dashboard, or the editor itself. See the product/systems spec
for the full plan (PRD, architecture, DB schema, timeline JSON format, rendering
pipeline, cost/risk, phased plan).

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
validated JSON document on `ProjectVersion.composition`. See the spec's
"Timeline JSON specification" for the format.

## Environment variables

See `apps/api/.env.example` and `apps/web/.env.example`. Never commit `.env` or
`.env.local` — both are gitignored.
