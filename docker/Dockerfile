# Một image cho cả api và worker (khác lệnh chạy) — Mục 9.2.
# Build: docker build -f docker/Dockerfile -t teachhub-backend .
#   api:     docker run teachhub-backend
#   worker:  docker run teachhub-backend node dist/apps/worker/main.js
#   migrate: docker build -f docker/Dockerfile --target migrate -t teachhub-migrate . (chạy với MIGRATION_DATABASE_URL)
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM build AS migrate
CMD ["node", "./node_modules/drizzle-kit/bin.cjs", "migrate"]

FROM base AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/apps/api/main.js"]
