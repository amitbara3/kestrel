# syntax=docker/dockerfile:1
#
# Multi-stage build. The runtime image carries no compiler, no dev dependencies,
# and no source — only the compiled output and production node_modules.

# ---------- deps: production dependencies only -------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` needs a lockfile; fall back to install so a fresh clone still builds.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---------- build: compile TypeScript ----------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
# The UI is static and is not emitted by tsc, so copy it alongside the output.
RUN cp -r src/public dist/public

# ---------- runtime ----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Alpine ships a `node` user (uid 1000); running as root in a container that
# terminates public traffic is not worth the convenience (Rules.md §5).
RUN apk add --no-cache wget && \
    mkdir -p /app && chown -R node:node /app

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Liveness only — readiness is the load balancer's concern, and a replica whose
# database is down must not be restarted in a loop.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# Exec form, so PID 1 is node itself and receives SIGTERM directly — that is
# what makes the graceful drain in src/index.ts actually run.
CMD ["node", "dist/index.js"]
