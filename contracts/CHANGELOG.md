# Lịch sử hợp đồng API

`contracts/openapi.json` sinh từ schema zod bằng `pnpm openapi:gen`; file này ghi endpoint thêm mới theo sprint. Chỉ thêm, không đổi endpoint cũ (CI chặn bằng `oasdiff`).

## Sprint 4 (S3-FL-12)

Thân hàm trả 501 `NOT_IMPLEMENTED` tới khi làm task backend tương ứng; schema đã validate thật. Không có bảng hay migration (S4-BE-01 làm cùng task backend).

| Endpoint | Task backend |
| --- | --- |
| `POST /v1/students/{id}/invites`, `GET /v1/students/{id}/invites`, `POST /v1/invites/{id}/revoke`, `POST /v1/invites/{id}/resend` | S4-BE-03 |
| `POST /v1/invites/preview`, `POST /v1/invites/accept`, `POST /v1/invites/redeem-code` | S4-BE-04 |
| `POST /v1/consents`, `GET /v1/consents/status` (bổ sung ngoài Spec §5.4) | S4-BE-05 |
| `GET /v1/family/students`, `GET /v1/family/students/{id}/attendance` | S4-BE-06 |
| `POST /v1/sessions/{id}/reschedule`, `POST /v1/sessions/{id}/cancel`, `POST /v1/sessions/{id}/makeup` | S4-BE-07 |
| `POST /v1/web-push/subscriptions`, `POST /v1/web-push/unsubscribe` (bổ sung ngoài Spec §5.4) | S4-BE-08b (P1) |
| `DELETE /v1/me` | S4-BE-09 |

Thay đổi trên endpoint cũ (chỉ thêm trường, không breaking):

- `Guardian` thêm `inviteStatus` và `latestInvite`; mỗi phần tử `GET /classes/{id}/roster` thêm `inviteStatus` và `guardians[]` (S4-BE-02).
- `Session` thêm `cancelReason` và `makeupOf`.
- Thông báo thêm loại `schedule_changed` (client bỏ qua `type` lạ như đã quy ước).
- `POST /auth/otp/send` thêm `purpose` (`login` mặc định, `delete_account`). Thân hàm hiện có chưa đọc `purpose`: S4-BE-09 phải tách mã theo mục đích trước khi bật `DELETE /me`.
- `PATCH /students/{id}` không đổi schema, chỉ ghi rõ giới hạn 2 phụ huynh → 422.

Mã lỗi mới: `SESSION_HAS_ATTENDANCE` (409), `INVITE_INVALID` (410), `INVITE_CODE_LOCKED` (429, `details.retryAfterSec`).

Quyết định khi soạn (cần TL chốt nếu muốn khác):

Lời mời:

- Một mã `INVITE_INVALID` (410) cho token/mã sai, sai định dạng, hết hạn, đã dùng, bị thu hồi, thay cho `INVITE_EXPIRED`/`INVITE_USED` của Spec §5.6, để không dò được trạng thái. Thân 410 không có thông tin giáo viên hay trẻ. Nút "Nhắn giáo viên xin link" hiện với mọi 410.
- Token không đi trong đường dẫn: `preview` và `accept` nhận `{token}` ở body (token sai định dạng cũng ra 410, không ra 422). Link chia sẻ `https://dayhoc.app/i#t=<token>`: fragment không vào log, CDN hay Referer. Trang landing phải đặt `Referrer-Policy: no-referrer` và `Cache-Control: no-store` (cần sửa S4-WEB-02 và deep link S4-FL-05, vốn theo mẫu `/i/{token}` của Spec).
- Preview chỉ trả tên giáo viên và tên gọi của trẻ (`studentGivenName`, tên cuối), không lớp, không họ. Họ tên đầy đủ chỉ trả sau `accept`.
- Chưa đồng ý → 403 `CONSENT_REQUIRED` (mã có sẵn trong Spec §5.6, kèm `details.termsVersion`), không phải 409 như Plan S4-BE-04. Kiểm đồng ý chạy trước khi xét token/mã để không dò được mã đúng sai.
- Giới hạn tần suất: `@Throttle` chỉ theo IP. Đếm theo user, khóa 5 lần sai/15 phút (`INVITE_CODE_LOCKED`), đếm theo IP (IPv6 theo /64) và bộ đếm toàn cục là bộ đếm riêng trong service. Phát lại phản hồi 410 đã lưu (cùng `Idempotency-Key`) và lỗi 422 không tính vào bộ đếm.
- Mã ngắn 8 ký tự Crockford (2^40), sống 48 giờ (`shortCodeExpiresAt`), ngắn hơn link 7 ngày. Giữ 8 ký tự; nâng lên 10 chỉ cần đổi pattern, chờ TL chốt.
- Lời mời gắn một phụ huynh (`guardianId` bắt buộc khi tạo). Tạo lại cho phụ huynh đang có lời mời `pending` thì lời mời cũ bị vô hiệu; `resend` làm việc đó theo id; phụ huynh đã `used` → 409 `CONFLICT_STALE`.
- "Mời tất cả phụ huynh chưa kích hoạt" chỉ lặp trên `not_invited` (tạo mới) và `expired` (`resend` bằng `latestInvite.id`), bỏ `invited` và `activated`.
- `token` và `shortCode` chỉ có ở `InviteCreated`. Phản hồi lưu cho `Idempotency-Key` của create/resend phải mã hóa khi nghỉ, TTL ≤ 10 phút. `GET /students/{id}/invites` có `acceptedBy` (tên hiển thị, lúc nhận). Rủi ro nhận nhầm do chuyển tiếp link được chấp nhận ở MVP: giáo viên gỡ liên kết qua `PATCH` `guardians`, người đó mất quyền xem `/family/**` ngay.
- Đối chiếu trạng thái:

| `InviteStatus` (một lời mời) | `GuardianInviteStatus` (một phụ huynh) |
| --- | --- |
| `pending` | `invited` |
| `used` | `activated` |
| `expired` | `expired` |
| `revoked` | `not_invited` (nếu không còn lời mời `pending`; `latestInvite` vẫn trỏ lời mời thu hồi) |
| không có lời mời | `not_invited`, `latestInvite = null` |

Ở roster, `inviteStatus` của học viên gộp theo phụ huynh: `activated` > `invited` > `expired` > `not_invited`.

Đồng ý xử lý dữ liệu:

- `POST /consents` chỉ thêm dòng (bằng chứng pháp lý), không sửa/xóa; cùng user, role, `termsVersion` trong 60 giây thì trả lại dòng vừa ghi (vẫn 201). Throttle 10 lần/phút. `acceptedAt`, `ip_hash`, user agent do server lấy. `termsVersion` khác bản hiện hành → 409 `CONFLICT_STALE`.
- `role` chỉ có `parent` ở Sprint 4 (Học sinh ngoài phạm vi). Chưa có `forStudentId`.
- Thêm `GET /consents/status?role=` (ngoài Spec) cho màn đồng ý và guard S4-FL-09. Ghi đồng ý không đòi membership; `/family/**` đòi cả membership Phụ huynh lẫn đã đồng ý.

`/family/**`:

- `week` là ngày ISO bất kỳ trong tuần (mặc định tuần hiện tại), tuần Thứ Hai đến Chủ Nhật theo múi giờ tenant. `summary.notRecorded` chỉ tính buổi đã qua giờ kết thúc; `upcoming` là buổi chưa tới. Không ghi chú giáo viên. Không có endpoint lịch riêng.
- Con không liên kết, của tenant khác hay không có đều 404.

Dời, hủy, buổi bù (US-2.2):

- Hủy buổi đã có điểm danh → 409 `SESSION_HAS_ATTENDANCE`; app hướng dẫn sửa điểm danh trước. Hủy buổi đã hủy → 200 idempotent, không gửi thông báo lần hai. Dời chỉ cho buổi `planned`. Buổi bù chỉ tạo từ buổi `cancelled`, mỗi buổi gốc một buổi bù (phỏng đoán từ Plan, cần TL chốt).
- Thông báo `schedule_changed` có `change` (`rescheduled`/`cancelled`/`makeup`), giờ mới/cũ, lý do; deepLink `teachhub://sessions/{sessionId}`.

Xóa tài khoản (US-0.9):

- `DELETE /me` body `{otp}`, 204; OTP sai dùng `OTP_INVALID`/`OTP_LOCKED` sẵn có. OTP gửi qua `otp/send` với `purpose = delete_account`. Mô tả ghi dữ liệu xóa/ẩn danh và phần giữ 5 năm theo Spec §4.8.

Web Push (P1):

- `endpoint` chỉ nhận `https`, không userinfo/cổng, host thuộc allowlist (`fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`) bằng `pattern`; server kiểm lại lúc gửi, không theo redirect; mỗi user tối đa 10 subscription, bảng theo user. `unsubscribe` ngoài Spec. `Idempotency-Key` tùy chọn như `push/register`. Khóa VAPID công khai lấy từ cấu hình build web.

## Sprint 3 (S2-FL-10)

Thân hàm trả 501 `NOT_IMPLEMENTED` tới khi làm task backend tương ứng; schema đã validate thật.

| Endpoint                                                       | Task backend |
| -------------------------------------------------------------- | ------------ |
| `GET /v1/sessions/{id}/attendance`, `POST /v1/attendance/sync` | S3-BE-02     |
| `GET /v1/sessions/{id}/attendance/history`                     | S3-BE-03     |
| `POST /v1/push/register`, `POST /v1/push/unregister`           | S3-BE-05     |
| `GET /v1/notifications`, `POST /v1/notifications/read`         | S3-BE-06     |

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

| Endpoint                                                                                                                                | Task backend       |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `POST /v1/auth/sso/apple`                                                                                                               | S2-BE-01           |
| `GET /v1/classes`, `POST /v1/classes`, `GET /v1/classes/{id}`, `PATCH /v1/classes/{id}`, `POST /v1/classes/{id}/archive`                | S2-BE-03           |
| `GET /v1/students`, `POST /v1/students`, `PATCH /v1/students/{id}`                                                                      | S2-BE-05           |
| `POST /v1/classes/{id}/enrollments`                                                                                                     | S2-BE-06           |
| `GET /v1/classes/{id}/roster`                                                                                                           | S2-BE-06b          |
| `PUT /v1/classes/{id}/schedule-rules`, `GET /v1/sessions`                                                                               | S2-BE-08           |
| `GET /v1/onboarding`, `PATCH /v1/onboarding/steps/{step}`                                                                               | S2-BE-10           |
| `POST /v1/center-waitlist`                                                                                                              | S2-BE-11           |
| `GET /v1/admin/bank-transfer-orders`, `POST /v1/admin/bank-transfer-orders/{id}/confirm`                                                | admin (US-0.8 AC3) |
| `GET /v1/admin/legal-articles` (bổ sung ngoài Spec §5.4), `POST /v1/admin/legal-articles`, `POST /v1/admin/legal-articles/{id}/publish` | admin (US-9.6)     |
| `GET /v1/admin/support/tenants/{id}`                                                                                                    | admin              |

Mã lỗi mới: `STUDENT_POSSIBLE_DUPLICATE` (409, `details.candidates` tối đa 5 ứng viên `StudentCandidate`). Hết hạn mức gói khai 402 `PLAN_LIMIT_EXCEEDED` (`details`: `limit`, `current`, `attempted`, `feature`) ở tạo lớp, tạo học viên, ghi danh.

Lệch có chủ ý so với Spec:

- `POST /v1/classes` trả lớp trần kèm `warnings: [{ code, message }]` (mặc định rỗng). Không nhận lịch lặp inline như ví dụ ở Spec §5.4 (lịch đặt qua `PUT /classes/{id}/schedule-rules`), và chưa có `409 WARNING_ACK_REQUIRED`.
- `GET /v1/sessions` giới hạn khoảng 62 ngày và không phân trang, ngoại lệ so với quy ước §5.5. `from` và `to` là ngày theo múi giờ tenant, bao gồm hai đầu.
- Mã trùng học viên theo Plan (`STUDENT_POSSIBLE_DUPLICATE`), không theo tên `DUPLICATE_STUDENT_SUSPECTED` ở Spec §5.6.

Ghi chú:

- Route `/v1/admin/**` trả 401 cho tới khi có AdminGuard (JwtAuthGuard toàn cục vẫn chặn). `GET /v1/admin/legal-articles` là bổ sung ngoài Spec §5.4, để trang admin liệt kê bài.
- Endpoint `files` chuyển sang task US-4.1, Sprint 2 chưa làm.

Route `/v1/admin/**` dùng ba security scheme riêng, không Bearer: `x-admin-secret`, `x-admin-user-id` (bắt buộc, không rỗng), `x-admin-permissions` (đúng một URI quyền cho thao tác: `/teachhub/admin/bank-transfer`, `/teachhub/admin/legal-articles` hoặc `/teachhub/admin/support`).
