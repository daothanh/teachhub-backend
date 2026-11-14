# teachhub-backend

Backend TeachHub — NestJS 12 modular monolith, một codebase hai tiến trình (Technical Spec MVP, Mục 2.4, 3, 8.2):

- `apps/api` — HTTP REST `/v1/**` (Fastify), health `/health/live`, `/health/ready` (PostgreSQL, Redis, kho S3)
- `apps/worker` — BullMQ consumer, outbox relay, job scheduler (không mở HTTP)

## Cấu trúc

```text
apps/api/src/        main.ts, app.ts (createApp dùng chung cho test), api.module.ts, health/
apps/worker/src/     main.ts, worker.module.ts
libs/core/           config (zod), CoreModule (config + pino), AppException, GlobalExceptionFilter, validationPipe, request id
libs/db/             DbModule (pg Pool + Drizzle), TxService (BEGIN + SET LOCAL app.user_id), schema/, migrations/
libs/infra/          RedisModule, ObjectStorage (kho S3: MinIO/R2); sau này: FCM, Web Push, SES, PDF, Excel
libs/modules/        (Sprint 1+) auth, identity, tenancy, … — mỗi module: http/ application/ domain/ infrastructure/ jobs/ index.ts
contracts/           error_codes.json (nguồn duy nhất cho API, web, app)
docker/              Dockerfile (api + worker + target migrate), postgres-init/ (vai trò DB local)
test/                e2e/integration với Testcontainers (PostgreSQL 17, Redis 7)
```

Import giữa lib dùng alias `@teachhub/core`, `@teachhub/db`, `@teachhub/infra`.

## Chạy local

```bash
cp .env.example .env
docker compose up -d          # PostgreSQL :5433, Redis :6380, MinIO :9000/:9001, Mailpit :8025
pnpm install
pnpm db:migrate               # chạy bằng vai trò teachhub_owner
pnpm start:api                # http://localhost:3000/health/ready
pnpm start:worker
```

Vai trò CSDL (Mục 2.5): `teachhub_owner` (migration), `teachhub_app` (api, không BYPASSRLS), `teachhub_worker` (worker, BYPASSRLS), `teachhub_readonly`. Local tạo bằng `docker/postgres-init/01-roles.sql`; staging/production tạo bằng Ansible **trước** khi chạy migration.

## Kiểm tra

```bash
pnpm check                    # lint + typecheck + unit test
pnpm test:e2e                 # cần Docker đang chạy (Testcontainers)
pnpm build
```

Dùng colima: đặt `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` và `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` trước khi chạy `test:e2e`.

## Quy ước chính

- Lỗi trả `{ code, message, details?, errors?, requestId }`; ném `new AppException('CODE', details)`, mã khai trong `contracts/error_codes.json`.
- Validate bằng zod: `@Body({ schema: createClassRequestSchema }) body: CreateClassRequest` — sai → 422 `VALIDATION_FAILED` + `errors: { field: string[] }`.
- Lệnh ghi chạy trong `txService.run({ userId }, async (tx) => …)` để RLS có `app.user_id`.
- Bảng nghiệp vụ mới: `enable` + `force row level security` và policy cho `teachhub_app` (mẫu ở `test/rls.e2e-spec.ts`).
- File `kebab-case.<loại>.ts`, route `/v1/<tài-nguyên-số-nhiều>`, JSON `camelCase`, SQL `snake_case` (Mục 8.5).
