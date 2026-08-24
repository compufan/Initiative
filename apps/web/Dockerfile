# syntax=docker/dockerfile:1
# Baut die PWA und liefert sie mit Caddy aus; /api und /ws gehen an die API.

FROM node:22-slim AS builder
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile || pnpm install
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @initiative/web build

FROM caddy:2-alpine
COPY --from=builder /build/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
