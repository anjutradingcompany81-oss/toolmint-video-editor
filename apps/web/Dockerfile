# Built from the repo root (docker-compose.prod.yml sets that as the build
# context) — same reasoning as apps/api/Dockerfile.

FROM node:20-bookworm-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# apps/api/package.json (copied above, needed for workspace-lockfile
# consistency) declares its own postinstall (prisma generate) — an
# unscoped `npm ci` here installs the whole workspace tree and would try
# to run that too, and fail without its schema file present. This image
# doesn't need Prisma at all, so just give postinstall what it needs to
# succeed rather than fight npm's workspace scoping.
COPY apps/api/prisma apps/api/prisma
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY apps/web apps/web
# NEXT_PUBLIC_* vars are inlined at build time, not read at runtime — must be
# passed as a build arg (docker-compose.prod.yml does this), not just set as
# a normal container env var later.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build --workspace apps/web

# output: "standalone" (next.config.mjs) produces a self-contained server —
# its own trimmed node_modules subset, no repo-root install needed here.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
