# syntax=docker/dockerfile:1
#
# All-in-one image: the Express API and the built Vue SPA in one container.
#
# Behind the two-image setup the SPA is served by its own nginx which proxies /api to the
# backend service, which means a deployer has to understand two containers, a compose
# network and CORS. Serving the static build from the API instead removes all of that: one
# image, one port, one volume, same origin - so no CORS at all and no nginx to configure.
#
# The two-image compose file in this repo still works for the deployment on the Pi; this
# Dockerfile is what gets published to ghcr.io and what the quickstart uses.

# ---------------------------------------------------------------- frontend build
FROM node:26-alpine AS frontend
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# vite build only: the type check runs in CI where it can fail the build cheaply.
RUN npm run build:docker

# ---------------------------------------------------------------- backend build
FROM node:26-slim AS backend
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
COPY backend/tsconfig.json ./
RUN npm ci
COPY backend/src ./src
COPY backend/prisma ./prisma
COPY backend/prisma.config.ts ./
RUN npx prisma generate && npm run build

# ---------------------------------------------------------------- runtime
FROM node:26-slim AS production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# All dependencies, including the prisma CLI: initializeDatabase() runs `prisma db push`
# on every start to keep the SQLite schema in step with the code.
COPY backend/package*.json ./
RUN npm ci && npm cache clean --force

COPY --from=backend /app/dist ./dist
# The generated client is compiled into dist (it lives in src/generated), so there is no
# node_modules/.prisma to copy any more - Prisma 7 has no such directory.
COPY backend/prisma ./prisma
# initializeDatabase runs `prisma db push` at start, and Prisma 7 reads the datasource URL
# from this file rather than from the schema.
COPY backend/prisma.config.ts ./
COPY --from=frontend /app/dist ./public

# Fail the build here rather than publishing an image that serves an empty page because the
# SPA build silently produced nothing.
RUN test -s /app/public/index.html

# /app/data holds the SQLite database; mount a volume there or the reports are lost on
# the next container replacement.
RUN mkdir -p /app/data && chmod 777 /app/data

ENV NODE_ENV=production \
    PORT=8096 \
    DATABASE_URL=file:/app/data/data.db \
    STATIC_DIR=/app/public
EXPOSE 8096

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8096/health || exit 1

CMD ["npm", "start"]
