# Monorepo-aware image for the API. Runs via tsx (no bundling) so the Prisma client and
# workspace TS packages resolve directly — simplest reliable path for a self-hosted MVP.
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

# Install all workspace deps (dev included — tsx runs the TS at runtime).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/ingestion/package.json packages/ingestion/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile || pnpm install

# Source
COPY packages ./packages
COPY apps/api ./apps/api

# Generate the Prisma client into packages/db/generated.
RUN pnpm --filter @meals/db generate

WORKDIR /repo/apps/api
EXPOSE 3001
CMD ["pnpm", "start"]
