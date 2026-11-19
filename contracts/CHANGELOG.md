# Lịch sử hợp đồng API

`contracts/openapi.json` sinh từ schema zod bằng `pnpm openapi:gen`; file này ghi endpoint thêm mới theo sprint. Chỉ thêm, không đổi endpoint cũ (CI chặn bằng `oasdiff`).

## Sprint 2 (S1-CT-02)

Thân hàm trả 501 `NOT_IMPLEMENTED` tới khi làm task backend tương ứng; schema đã validate thật.

| Endpoint | Task backend |
| --- | --- |
| `POST /v1/auth/sso/apple` | S2-BE-01 |
| `GET /v1/classes`, `POST /v1/classes`, `GET /v1/classes/{id}`, `PATCH /v1/classes/{id}`, `POST /v1/classes/{id}/archive` | S2-BE-03 |
| `GET /v1/students`, `POST /v1/students`, `PATCH /v1/students/{id}` | S2-BE-05 |
| `POST /v1/classes/{id}/enrollments` | S2-BE-06 |
| `GET /v1/classes/{id}/roster` | S2-BE-06b |
| `PUT /v1/classes/{id}/schedule-rules`, `GET /v1/sessions` | S2-BE-08 |
| `GET /v1/onboarding`, `PATCH /v1/onboarding/steps/{step}` | S2-BE-10 |
| `POST /v1/center-waitlist` | S2-BE-11 |
| `GET /v1/admin/bank-transfer-orders`, `POST /v1/admin/bank-transfer-orders/{id}/confirm` | admin (US-0.8 AC3) |
| `GET /v1/admin/legal-articles` (bổ sung ngoài Spec §5.4), `POST /v1/admin/legal-articles`, `POST /v1/admin/legal-articles/{id}/publish` | admin (US-9.6) |
| `GET /v1/admin/support/tenants/{id}` | admin |

Mã lỗi mới: `STUDENT_POSSIBLE_DUPLICATE` (409).

Route `/v1/admin/**` dùng ba security scheme riêng, không Bearer: `x-admin-secret`, `x-admin-user-id` (bắt buộc, không rỗng), `x-admin-permissions` (đúng một URI quyền cho thao tác: `/teachhub/admin/bank-transfer`, `/teachhub/admin/legal-articles` hoặc `/teachhub/admin/support`).
