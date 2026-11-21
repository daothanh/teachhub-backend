# ADR-TH-BE-001: Quy ước migration và CSDL lớn dần

- Trạng thái: Proposed · 15/11/2026 (chờ TL duyệt trong PR)
- Liên quan: Technical Spec MVP §2.4, §2.5, §4.1, §4.4, §4.5 (R1–R6), §5.1, §9.2; Kế hoạch triển khai §1.2, §6.3; S0-BE-04 (#31), S0-BE-07 (#34)

## Bối cảnh

ERD ở Technical Spec §4 có ~60 bảng. Dựng hết một lần thì bảng chưa có story dùng không có test,
mỗi lần đổi nghiệp vụ phải sửa migration hàng loạt, và backend (đường găng) mất 2–3 tuần đầu
mà client chưa có gì để gọi. Ta tạo bảng theo story, nhưng phải giữ ba bất biến từ ngày đầu:
cách ly tenant bằng RLS, migration chạy lại được trên CSDL trống, và không phá bản đang chạy
khi triển khai cuốn chiếu.

Hiện trạng đã có: Drizzle ORM + `drizzle-kit`, migration `0000_init` (extension, schema
`app_private`, quyền mặc định, `app_private.set_updated_at()`), 4 vai trò CSDL, `TxService`
đặt `app.user_id` bằng `set_config(..., true)`, e2e RLS mẫu.

## Quyết định

### 1. Thiết kế đủ, migrate dần

- ERD §4 là bản thiết kế đích: **giữ đúng tên bảng/cột** khi tạo. Đổi tên so với ERD phải sửa spec trong cùng PR.
- Migration của một sprint chỉ chứa bảng mà story trong sprint đó dùng. Một PR migration ↔ một story.
- Thứ dùng chung có từ Sprint 0–1 và không bao giờ "thêm sau": cột chuẩn, vai trò, helper RLS,
  bảng hạ tầng `idempotency_keys`, `job_runs`, `audit_logs`.

### 2. Công cụ và cách viết

| Việc | Cách làm |
| --- | --- |
| Bảng, cột, index, khóa ngoại | Khai báo trong `libs/db/src/schema/<module>.ts`, sinh SQL bằng `pnpm db:generate --name <mo-ta>` |
| RLS (policy), trigger, hàm `app_private`, partition, CHECK phức tạp | SQL viết tay trong migration rỗng: `pnpm db:generate --custom --name <mo-ta>` |
| Tên file | `NNNN_<mô-tả-snake-case>.sql` (luôn truyền `--name`, không dùng tên ngẫu nhiên của drizzle-kit) |
| Chạy | `node scripts/migrate.mjs` (migrator của `drizzle-orm`, cùng cơ chế `drizzle-kit migrate`) bằng vai trò **`teachhub_owner`** (`MIGRATION_DATABASE_URL`), chạy **trước** khi deploy `api`/`worker`, cùng image với lệnh khác |
| Vai trò CSDL | Không tạo trong migration. Local: `docker/postgres-init/`; staging/production: Ansible, trước migration đầu tiên |

Quyền: bảng do `teachhub_owner` tạo tự cấp DML cho `teachhub_app`/`teachhub_worker` và `select` cho
`teachhub_readonly` (default privileges trong `0000_init`). `teachhub_app` **không** sở hữu bảng và
**không** BYPASSRLS — có test e2e chứng minh (`test/rls.e2e-spec.ts`), chạy trong CI.

### 3. Bảng nghiệp vụ mới — checklist bắt buộc trong cùng PR

1. Cột chuẩn: `id uuid primary key` (UUID v7 **sinh ở ứng dụng/app**, không default ở CSDL),
   `tenant_id uuid not null`, `branch_id uuid not null` nếu dữ liệu thuộc chi nhánh, `created_at`,
   `updated_at` (trigger `trg_<bảng>_updated_at` gọi `app_private.set_updated_at()`), `created_by`,
   `deleted_at` khi cần xóa mềm.
2. `alter table … enable row level security; alter table … force row level security;` và policy
   `to teachhub_app` cho cả `using` lẫn `with check`. Bảng hạ tầng chỉ api/worker dùng
   (`idempotency_keys`, `job_runs`, `outbox_events`, `refresh_tokens`) cũng bật RLS, policy theo `app.user_id` hoặc
   không có policy cho `teachhub_app` nếu chỉ worker đọc.
3. Index truy vấn chính bắt đầu bằng `tenant_id`.
4. Kiểu dữ liệu: tiền `bigint` (đồng), thời điểm `timestamptz`, ngày học `date`, điểm `numeric(5,2)`,
   enum là `text` + `CHECK` (không `CREATE TYPE … ENUM`).
5. Trigger audit (`audit_logs`, S0-BE-09) gắn vào bảng có dữ liệu nhạy cảm (§6.3: `attendance`,
   `grades`, `invoices`, `invoice_lines`, `payments`, `payment_claims`).
6. Test chéo tenant (khung ở S0-BE-06, R5): user tenant A đọc/ghi tenant B → 0 dòng / lỗi.
7. CI chặn bảng `public` thiếu RLS (S0-BE-06, R1).

### 4. Chỉ expand, không phá (triển khai cuốn chiếu)

`api` bản cũ và bản mới chạy song song trong lúc deploy, và app mobile cũ còn sống nhiều tuần.
Mỗi migration phải chạy được với **mã của bản phát hành trước**:

| Muốn | Làm |
| --- | --- |
| Thêm cột | Cho phép null hoặc có default hằng số |
| Đổi tên / đổi kiểu cột | Expand → migrate → contract qua **2 bản phát hành**: thêm cột mới, ghi cả hai, backfill; bản sau mới đọc cột mới; bản sau nữa mới xóa cột cũ |
| Xóa cột/bảng | Chỉ khi không bản nào đang chạy còn đọc; luôn ở bản phát hành sau bản ngừng dùng |
| `NOT NULL` cho cột đã có dữ liệu | Thêm `CHECK (…) NOT VALID` → `VALIDATE CONSTRAINT` ở migration sau |

Migration đã merge vào `main` **không sửa nữa**; sai thì viết migration mới.

### 5. Hai bẫy của drizzle-kit cần nhớ

- **Thứ tự theo thời điểm sinh:** migrator chỉ chạy migration có `when` (trong `meta/_journal.json`)
  **lớn hơn** migration mới nhất đã chạy. Hai nhánh cùng sinh migration song song → nhánh merge sau
  có `when` cũ hơn sẽ **bị bỏ qua im lặng** trên môi trường đã migrate. Quy tắc: trước khi merge PR có
  migration, rebase lên `main` rồi **xóa và sinh lại** migration của mình (số thứ tự và `when` mới).
  CI kiểm `idx` liên tục và `when` tăng dần (S0-BE-08).
- **Một giao dịch cho cả lô:** `migrate` chạy mọi migration đang chờ trong **một** giao dịch. Vì vậy
  không dùng được `CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE` trong migration. Bảng còn nhỏ
  (MVP đến Sprint 6) thì tạo index thường; khi một bảng vượt ~1 triệu dòng, index lớn chạy bằng script
  riêng ngoài drizzle theo runbook (quyết định cơ chế khi có production — trước Sprint 7).

### 6. Bảng phân vùng

`audit_logs` (và sau này `notifications`, `notification_deliveries`) phân vùng theo tháng (`partition by range (created_at)`),
không có phân vùng `default` để lỗi lộ ra sớm thay vì dồn dữ liệu vào một chỗ. Phân vùng **tự tạo khi cần**:
`app_private.audit_insert` gọi `app_private.ensure_audit_partition(now())` trước khi ghi (một lần tra
`to_regclass` mỗi dòng), migration tạo sẵn tháng hiện tại và tháng sau. Không phụ thuộc job của worker
để tránh mất audit khi worker chưa chạy; job của worker chỉ **xóa** phân vùng quá hạn lưu (§4.8, khi có).
Mỗi phân vùng bật + ép RLS, không policy: không ai đọc thẳng phân vùng để né policy của bảng cha.

### 7. Hợp đồng OpenAPI (bổ sung ở S0-BE-07)

Đã kiểm 15/11/2026: `nestjs-zod` 5.6 khai peer `@nestjs/common ^10 || ^11` — **không hỗ trợ NestJS 12**.
Không cần nó: NestJS 12 validate bằng Standard Schema (`@Body({ schema })`) và `@nestjs/swagger` 12 sinh
OpenAPI 3.1 trực tiếp từ schema zod 4 (`@ApiOkResponse({ standardSchema })`, request lấy từ `schema`
của decorator tham số). Cũng không cần `zod-openapi`; chỉ dùng tới nó qua `standardSchemaConverter`
nếu chuyển đổi gốc thiếu tính năng.

- `contracts/openapi.json` sinh bằng `pnpm openapi:gen`, commit cùng PR; `apps/api/src/openapi.spec.ts`
  đỏ khi file lệch mã.
- Job CI `openapi-breaking` chạy `oasdiff breaking` so với nhánh đích, lỗi mức ERR → PR đỏ.
- Route ngoài hợp đồng (health) gắn `@ApiExcludeController()`.

### 8. Trạng thái onboarding lưu trong `tenants.settings` (bổ sung ở S2-BE-10)

Trạng thái 5 bước onboarding (US-0.2) nằm ở `tenants.settings.onboarding.steps`, dạng `{ "<bước>": "done" | "skipped" }`.
Bước chưa có khóa = `pending`; `currentStep` tính lúc đọc (bước `pending` đầu tiên), không lưu.

- Lý do: onboarding thuộc về tenant (một tenant một trạng thái), chỉ có 5 giá trị, không truy vấn chéo tenant.
  Một bảng riêng cần migration, RLS và audit mà không có thêm lợi ích; `settings` là jsonb đã có RLS theo tenant.
- Ghi bằng một lệnh `update … settings || jsonb_build_object(…)` sau `select … for update`: hai PATCH đồng thời
  không đè khóa của nhau, các khóa khác trong `settings` được giữ nguyên.
- Khi cần báo cáo (tỷ lệ hoàn tất onboarding), đọc từ sự kiện analytics (`onboarding_step_completed`,
  `onboarding_skipped`), không quét `settings`. Nếu sau này cần truy vấn theo bước thì tách bảng, kèm backfill.

## Hệ quả

- Mỗi sprint có migration nhỏ, review được; ERD vẫn là đích nên tên bảng ổn định cho client.
- Người review migration dùng checklist ở PR template (§6.3 kế hoạch) — trùng mục 3–4 ở trên.
- Đổi tên/xóa cột tốn 2 bản phát hành: chấp nhận đổi lại sự an toàn khi deploy cuốn chiếu.
- Còn mở: cơ chế index `CONCURRENTLY` (mục 5).
