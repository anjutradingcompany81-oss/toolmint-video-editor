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
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/prisma apps/api/prisma
RUN npm ci --workspace apps/api --omit=dev
COPY --from=build /repo/apps/api/dist apps/api/dist

EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
