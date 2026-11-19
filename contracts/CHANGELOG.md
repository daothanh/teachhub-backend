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

Mã lỗi mới: `ATTENDANCE_EDIT_WINDOW_CLOSED` (422). Chỉ xuất hiện trong `errorCode` của phần tử `rejected` ở kết quả sync, không phải lỗi HTTP của cả lô.

Quyết định khi soạn (cần TL chốt nếu muốn khác):

- `POST /attendance/sync` trả HTTP 200 kể cả khi có phần tử bị từ chối; kết quả mỗi phần tử là `applied`, `duplicate`, `stale` hoặc `rejected` (kèm `errorCode`). Dùng `stale` theo Spec §5.4 và Plan, không dùng `conflict`.
- Một lô cho một buổi (`sessionId` ở cấp lô), tối đa 500 mutation, `clientMutationId` không được lặp trong lô. Sửa sau cũng đi qua sync, không có PATCH riêng.
- Bỏ `billingRecalculated` khỏi kết quả sync vì `billing` chưa có tới Sprint 5. `parentsToNotify` giữ nguyên theo Spec.
- `GET /sessions/{id}/attendance` chưa có báo vắng trước của phụ huynh (US-3.4 ngoài Sprint 3); thêm `canEdit` (cửa sổ 7 ngày) và `serverTime` (hiệu chỉnh lệch đồng hồ).
- Nhật ký sửa không phân trang, tối đa 500 dòng mới nhất.
- Đăng ký token FCM giữ đường dẫn `/push/register` và `/push/unregister` theo Spec G10 (nhóm tag `devices`). Body có `userId` để khớp gói `tasco_notifications`; khác user của token → 403.
- Hộp thông báo dùng con trỏ (`cursor`, `limit` tối đa 50). `POST /notifications/read` nhận danh sách `ids` (tối đa 100); chưa có "đọc tất cả".
- Payload thông báo chỉ có tên con, lớp, giờ buổi và id để mở đúng màn.
- Cả bốn POST ghi bắt buộc `Idempotency-Key` theo Spec §5.1, kể cả `push/*` và `notifications/read` vốn đã idempotent.

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

- Route `/v1/admin/**` trả 401 cho tới khi có AdminGuard (JwtAuthGuard toàn cục vẫn chặn). `GET /v1/admin/legal-articles` là bổ sung ngoài Spec §5.4, để trang admin liệt kê bài.
- Endpoint `files` chuyển sang task US-4.1, Sprint 2 chưa làm.

Route `/v1/admin/**` dùng ba security scheme riêng, không Bearer: `x-admin-secret`, `x-admin-user-id` (bắt buộc, không rỗng), `x-admin-permissions` (đúng một URI quyền cho thao tác: `/teachhub/admin/bank-transfer`, `/teachhub/admin/legal-articles` hoặc `/teachhub/admin/support`).
