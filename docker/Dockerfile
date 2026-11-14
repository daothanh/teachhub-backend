# Một image cho api, worker và migration (khác lệnh chạy) — Mục 9.2.
# Build: docker build -f docker/Dockerfile -t teachhub-backend .
#   api:     docker run teachhub-backend
#   worker:  docker run teachhub-backend node dist/apps/worker/main.js
#   migrate: docker run -e MIGRATION_DATABASE_URL=… teachhub-backend node scripts/migrate.mjs
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Chỉ cần `node` lúc chạy: gỡ npm/corepack/yarn đi kèm image gốc (mang dependency có CVE, Trivy chặn).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY libs/db/migrations ./libs/db/migrations
COPY scripts/migrate.mjs ./scripts/
USER node
EXPOSE 3000
CMD ["node", "dist/apps/api/main.js"]
