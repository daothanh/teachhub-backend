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

Mã lỗi mới: `STUDENT_POSSIBLE_DUPLICATE` (409, `details.candidates` tối đa 5 ứng viên `StudentCandidate`). Hết hạn mức gói khai 402 `PLAN_LIMIT_EXCEEDED` (`details`: `limit`, `current`, `attempted`, `feature`) ở tạo lớp, tạo học viên, ghi danh.

Lệch có chủ ý so với Spec:

- `POST /v1/classes` trả lớp trần kèm `warnings: [{ code, message }]` (mặc định rỗng). Không nhận lịch lặp inline như ví dụ ở Spec §5.4 (lịch đặt qua `PUT /classes/{id}/schedule-rules`), và chưa có `409 WARNING_ACK_REQUIRED`.
- `GET /v1/sessions` giới hạn khoảng 62 ngày và không phân trang, ngoại lệ so với quy ước §5.5. `from` và `to` là ngày theo múi giờ tenant, bao gồm hai đầu.
- Mã trùng học viên theo Plan (`STUDENT_POSSIBLE_DUPLICATE`), không theo tên `DUPLICATE_STUDENT_SUSPECTED` ở Spec §5.6.

Ghi chú:

- `POST /v1/auth/sso/apple` (S2-BE-01), quy ước nonce: client sinh nonce thô, gửi nonce **thô** trong body và gửi SHA-256(nonce) dạng hex cho Apple. Server băm nonce thô rồi so với claim `nonce`. `aud` là bundle ID đọc từ `APPLE_BUNDLE_ID`; chỉ nhận RS256/ES256. Mỗi `identityToken` dùng được một lần (dùng lại → 401), nên client lỗi mạng phải xin token Apple mới thay vì gửi lại.
- Route `/v1/admin/**` trả 401 cho tới khi có AdminGuard (JwtAuthGuard toàn cục vẫn chặn). `GET /v1/admin/legal-articles` là bổ sung ngoài Spec §5.4, để trang admin liệt kê bài.
- Endpoint `files` chuyển sang task US-4.1, Sprint 2 chưa làm.

Route `/v1/admin/**` dùng ba security scheme riêng, không Bearer: `x-admin-secret`, `x-admin-user-id` (bắt buộc, không rỗng), `x-admin-permissions` (đúng một URI quyền cho thao tác: `/teachhub/admin/bank-transfer`, `/teachhub/admin/legal-articles` hoặc `/teachhub/admin/support`).
