# syntax=docker/dockerfile:1
# Baut die PWA und liefert sie mit Caddy aus; /api und /ws gehen an die API.

FROM node:22-slim AS builder
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile || pnpm install
# Leer lassen, wenn PWA und API unter derselben Domain liegen – dann sind alle
# Anfragen relativ und der WebSocket folgt der Domain von allein.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
# Damit in den Einstellungen steht, welcher Stand gerade laeuft. Ohne das
# zeigt die App dort dauerhaft "dev".
ARG GITHUB_SHA=""
ENV GITHUB_SHA=$GITHUB_SHA
ARG VITE_APP_VERSION=""
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ARG VITE_REPO_URL=""
ENV VITE_REPO_URL=$VITE_REPO_URL
RUN pnpm --filter @initiative/web build

FROM caddy:2-alpine
COPY --from=builder /build/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
