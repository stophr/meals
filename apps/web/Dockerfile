# Build the PWA, then serve the static bundle with nginx (SPA fallback).
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile || pnpm install

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# API base URL baked at build time. "/api" = same-origin via the nginx proxy,
# which works from any device (phone on LAN). Override with --build-arg for split hosting.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @meals/web build

FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
