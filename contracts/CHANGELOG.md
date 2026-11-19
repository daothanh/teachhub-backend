# Lịch sử hợp đồng API

`contracts/openapi.json` sinh từ schema zod bằng `pnpm openapi:gen`; file này ghi endpoint thêm mới theo sprint. Chỉ thêm, không đổi endpoint cũ (CI chặn bằng `oasdiff`).

## Sprint 3 (S2-FL-10)

Thân hàm trả 501 `NOT_IMPLEMENTED` tới khi làm task backend tương ứng; schema đã validate thật.

| Endpoint | Task backend |
| --- | --- |
| `GET /v1/sessions/{id}/attendance`, `POST /v1/attendance/sync` | S3-BE-02 |
| `GET /v1/sessions/{id}/attendance/history` | S3-BE-03 |
| `POST /v1/push/register`, `POST /v1/push/unregister` | S3-BE-05 |
| `GET /v1/notifications`, `POST /v1/notifications/read` | S3-BE-06 |

Mã lỗi mới: `ATTENDANCE_EDIT_WINDOW_CLOSED` (422, chỉ trong `errorCode` của phần tử `rejected`, không phải lỗi HTTP cả lô) và `SESSION_CANCELLED` (409, buổi đã hủy).

Quyết định khi soạn (cần TL chốt nếu muốn khác):

Đồng bộ điểm danh:

- `POST /attendance/sync` trả HTTP 200 kể cả khi có phần tử bị từ chối. Mỗi phần tử có `clientMutationId`, `studentId`, `result` (`applied`, `duplicate`, `stale`, `rejected`), `errorCode` khi `rejected`, và `current` (`status`, `note`, `clientUpdatedAt`, `recordedByName?`) khi `stale` hoặc `duplicate`. Dùng `stale` theo Spec §5.4 và Plan, không dùng `conflict`.
- LWW: mutation chỉ thắng khi `clientUpdatedAt` lớn hơn (`>`) mốc đang lưu, đã hiệu chỉnh lệch đồng hồ; bằng nhau là `stale`. Item đọc có `clientUpdatedAt` và `syncedAt`. Kết quả sync có `serverTime`.
- `clientMutationId` có phạm vi tenant (khóa dedupe `(tenant_id, client_mutation_id)`). `duplicate` chỉ khi bản cũ cùng tenant và cùng `sessionId`.
- `rejected` kèm `NOT_FOUND`: học viên của tenant khác và học viên không thuộc lớp cho cùng kết quả. `READONLY_PLAN_LIMIT` giữ trong `errorCode` vì Spec §5.4 liệt kê.
- Lô lỗi cả lô: buổi không có → 404, buổi đã hủy → 409 `SESSION_CANCELLED`. Client đánh dấu lô lỗi, giữ cho người dùng xem, không retry vô hạn.
- `markSessionTaught` khi buổi đã "đã dạy": idempotent, bỏ qua cờ, không trả `SESSION_ALREADY_TAUGHT`.
- Học viên không có trong lô được hiểu là "Có mặt": chỉ tạo dòng cho học viên chưa có dòng, `summary` đếm cả dòng tạo ngầm.
- Một lô cho một buổi, tối đa 500 mutation, `clientMutationId` không lặp trong lô. Sửa sau cũng đi qua sync, không có PATCH riêng. `note` dùng chung một schema (cắt khoảng trắng, tối đa 500 ký tự).
- Bỏ `billingRecalculated` vì `billing` chưa có tới Sprint 5. `parentsToNotify` giữ nguyên theo Spec.

Đọc điểm danh và nhật ký:

- `GET /sessions/{id}/attendance` chưa có báo vắng trước của phụ huynh (US-3.4 ngoài Sprint 3). Thêm `sessionDate` (múi giờ tenant), `canEdit` (false khi quá 7 ngày theo ngày buổi học hoặc buổi đã hủy), `editableUntil` và `serverTime`.
- Nhật ký sửa phân trang con trỏ (`cursor`, `limit` tối đa 100, `nextCursor`) theo Spec §5.5. Chỉ trả `changedByName`, không trả userId hay email. `cursorQuerySchema` và `cursorPageSchema` đặt ở `libs/core`, dùng chung với thông báo.
- Route điểm danh yêu cầu vai trò `tenant_owner`.

Thông báo và thiết bị:

- Đường dẫn FCM giữ `/push/register` và `/push/unregister` theo Spec G10 (tag `devices`). Body giữ `userId` để khớp gói `tasco_notifications`; server so với user của token, lệch → 403, không dùng `userId` ở body làm danh tính.
- `Idempotency-Key` của `push/*` là tùy chọn (idempotent theo `deviceToken`); bắt buộc với `attendance/sync` và `notifications/read`.
- Push FCM là data-only, chỉ có `notificationId` và `type`; không có tên con, lớp hay trạng thái vắng trên khay. App gọi `GET /notifications` sau khi mở.
- Hộp thông báo dùng con trỏ (`limit` tối đa 50). `payload` là discriminated union theo `type` (`student_absent`, `student_absent_correction`), có `deepLink` tùy chọn; client bỏ qua `type` lạ. Payload chỉ có tên con, lớp, giờ buổi và id.
- `POST /notifications/read` nhận `ids` (tối đa 100); id trùng chỉ tính một lần; id của người khác và id không tồn tại không phân biệt, đều bị bỏ qua. Chưa có "đọc tất cả".

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

Làm rõ (S2-BE-05, chỉ đổi mô tả): `guardians[].id` phải là phụ huynh đang liên kết với chính học viên đó, sai → 422 ở `guardians.N.id`; `POST /v1/students` không nhận `id`.

Làm rõ (S2-BE vòng sửa, chỉ thêm mô tả lỗi): `POST /v1/classes` và `POST /v1/students` khai thêm 409 `CONFLICT_STALE` (`id` do client gửi đã tồn tại); `PATCH /v1/classes/{id}` trên lớp đã lưu trữ → 409 `CONFLICT_STALE`; `POST /v1/center-waitlist` khai thêm 429 `RATE_LIMITED` (5 request/giờ/IP).

Lệch có chủ ý so với Spec:

- `POST /v1/classes` trả lớp trần kèm `warnings: [{ code, message }]` (mặc định rỗng). Không nhận lịch lặp inline như ví dụ ở Spec §5.4 (lịch đặt qua `PUT /classes/{id}/schedule-rules`), và chưa có `409 WARNING_ACK_REQUIRED`.
- `GET /v1/sessions` giới hạn khoảng 62 ngày và không phân trang, ngoại lệ so với quy ước §5.5. `from` và `to` là ngày theo múi giờ tenant, bao gồm hai đầu.
- Mã trùng học viên theo Plan (`STUDENT_POSSIBLE_DUPLICATE`), không theo tên `DUPLICATE_STUDENT_SUSPECTED` ở Spec §5.6.

Ghi chú:

- Route `/v1/admin/**` trả 401 cho tới khi có AdminGuard (JwtAuthGuard toàn cục vẫn chặn). `GET /v1/admin/legal-articles` là bổ sung ngoài Spec §5.4, để trang admin liệt kê bài.
- Endpoint `files` chuyển sang task US-4.1, Sprint 2 chưa làm.

Route `/v1/admin/**` dùng ba security scheme riêng, không Bearer: `x-admin-secret`, `x-admin-user-id` (bắt buộc, không rỗng), `x-admin-permissions` (đúng một URI quyền cho thao tác: `/teachhub/admin/bank-transfer`, `/teachhub/admin/legal-articles` hoặc `/teachhub/admin/support`).
