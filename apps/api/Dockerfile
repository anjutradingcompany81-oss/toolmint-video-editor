# Built from the repo root (docker-compose.prod.yml sets that as the build
# context) since this is an npm-workspaces monorepo and apps/api's
# package-lock.json entries live in the root lockfile.

FROM node:20-bookworm-slim AS deps
WORKDIR /repo
# Prisma's postinstall (`prisma generate`, triggered by `npm ci` below) needs
# a matching OpenSSL present to pick the right query-engine binary target —
# bookworm-slim doesn't ship one by default, and skipping this produces a
# client that fails at *runtime* ("could not detect libssl"), not build time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# prisma generate (postinstall, triggered by npm ci next) needs the actual
# schema file present — this has to land before npm ci runs, not after.
COPY apps/api/prisma apps/api/prisma
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /repo
# Needed here too, not just in `deps`/`runtime` — this stage is also used
# standalone (deploy.yml builds it as `toolmint-api-migrate`) to run the
# v1->v2 data migration script directly against Postgres via Prisma
# Client, which needs to detect the local OpenSSL version to pick the
# right query-engine binary. Without it Prisma silently mis-detects the
# target and fails at the first query, not at build time — confirmed live
# ("Prisma Client was generated for debian-openssl-3.0.x, but the actual
# deployment required debian-openssl-1.1.x").
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
# `npm run --workspace` needs the root package.json to know what a
# "workspace" even is — easy to forget since it's not itself a dependency,
# just plumbing npm reads directly.
COPY package.json package-lock.json ./
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY apps/api apps/api
RUN npm run build --workspace apps/api

# node_modules built fresh here (not copied from the deps stage) so
# postinstall runs again with NODE_ENV=production already set — ffmpeg-static
# downloads its platform binary and Prisma generates its client during
# install, both need to happen inside this Linux image, not on whatever OS
# built the deps stage.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 python3-venv python3-pip && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/prisma apps/api/prisma
RUN npm ci --workspace apps/api --omit=dev
COPY --from=build /repo/apps/api/dist apps/api/dist

# AI Repetitive Voice Remover's speaker-diarization sidecar
# (voice/audio-analysis/diarization.service.ts spawns this as a one-shot
# subprocess per scan, never a persistent service). Isolated in its own
# venv — bookworm's system Python refuses a bare `pip install` outside
# one — so it can never conflict with anything Node-side. CPU-only torch,
# since this VPS has no GPU. This is a genuinely heavy addition (several
# GB once torch + pyannote's own dependencies are installed, and the
# model weights themselves download on first real use, not at build
# time) — see deploy/README.md's "AI Voice Remover resource requirements"
# before enabling HUGGINGFACE_TOKEN in production.
COPY apps/api/python apps/api/python
RUN python3 -m venv apps/api/python/.venv \
    && apps/api/python/.venv/bin/pip install --no-cache-dir -r apps/api/python/requirements.txt

EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
