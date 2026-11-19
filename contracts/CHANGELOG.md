# Lịch sử hợp đồng API

`contracts/openapi.json` sinh từ schema zod bằng `pnpm openapi:gen`; file này ghi endpoint thêm mới theo sprint. Chỉ thêm, không đổi endpoint cũ (CI chặn bằng `oasdiff`).

## Sprint 4 (S3-FL-12)

Thân hàm trả 501 `NOT_IMPLEMENTED` tới khi làm task backend tương ứng; schema đã validate thật. Không có bảng hay migration (S4-BE-01 làm cùng task backend).

| Endpoint                                                                                                                          | Task backend   |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `POST /v1/students/{id}/invites`, `GET /v1/students/{id}/invites`, `POST /v1/invites/{id}/revoke`, `POST /v1/invites/{id}/resend` | S4-BE-03       |
| `GET /v1/invites/{token}/preview`, `POST /v1/invites/{token}/accept`, `POST /v1/invites/redeem-code`                              | S4-BE-04       |
| `POST /v1/consents`, `GET /v1/consents/status` (bổ sung ngoài Spec §5.4)                                                          | S4-BE-05       |
| `GET /v1/family/students`, `GET /v1/family/students/{id}/attendance`                                                              | S4-BE-06       |
| `POST /v1/web-push/subscriptions`, `POST /v1/web-push/unsubscribe` (bổ sung ngoài Spec §5.4)                                      | S4-BE-08b (P1) |

Thay đổi trên endpoint cũ (chỉ thêm trường ở phản hồi, không breaking): `Guardian` có thêm `inviteStatus`; mỗi phần tử `GET /classes/{id}/roster` có thêm `inviteStatus` và `guardians[]` (S4-BE-02). `PATCH /students/{id}` không đổi schema, chỉ ghi rõ giới hạn 2 phụ huynh → 422.

Mã lỗi mới: `INVITE_INVALID` (410) và `INVITE_CODE_LOCKED` (429, `details.retryAfterSec`).

Không nằm trong hợp đồng này: US-2.2 (dời/hủy/buổi bù, S4-BE-07) và `DELETE /me` (S4-BE-09) không thuộc phạm vi S3-FL-12; kênh email (S4-BE-08) không có endpoint.

Quyết định khi soạn (cần TL chốt nếu muốn khác):

Lời mời:

- Một mã lỗi `INVITE_INVALID` (410) cho token/mã sai, sai định dạng, hết hạn, đã dùng, bị thu hồi, thay cho hai mã `INVITE_EXPIRED`/`INVITE_USED` của Spec §5.6, để không dò được trạng thái lời mời. Nút "Nhắn giáo viên xin link" hiện với mọi 410. Tham số `{token}` ở đường dẫn chỉ giới hạn độ dài (≤ 128), nên token sai định dạng cũng ra 410, không ra 422.
- Chưa đồng ý → 403 `CONSENT_REQUIRED` (mã có sẵn trong Spec §5.6, kèm `details.termsVersion`), không phải 409 như câu chữ của Plan S4-BE-04. Kiểm đồng ý chạy trước khi xét token/mã nên người chưa đồng ý không dò được mã đúng sai.
- `accept` và `redeem-code` đều cần đăng nhập, cùng trả `InviteAccepted` (`membershipId`, `studentId`, `studentName`). `redeem-code` khóa theo user 5 lần sai/15 phút (Spec: `lock:invite:{userId}`) → 429 `INVITE_CODE_LOCKED`; kèm giới hạn IP 10 lần/phút. `preview` công khai, 30 lần/phút mỗi IP.
- Lời mời gắn với một phụ huynh (`guardianId` bắt buộc khi tạo), vì `invites.guardian_id` và trạng thái mời tính theo từng phụ huynh. "Mời tất cả phụ huynh chưa kích hoạt" là client gọi lặp theo `roster.guardians[]`.
- Tạo lại cho phụ huynh đang có lời mời `pending` thì lời mời cũ bị vô hiệu (Plan S4-BE-03). `resend` làm đúng việc đó theo id lời mời; không làm gì với phụ huynh đã `used` (409 `CONFLICT_STALE`).
- `token` và `shortCode` chỉ có trong phản hồi tạo/gửi lại (`InviteCreated`). `GET /students/{id}/invites` không trả cả hai, nên giáo viên muốn chia sẻ lại phải bấm gửi lại. Link là `https://dayhoc.app/i/{token}`, QR do client sinh từ chuỗi này, không có trường ảnh QR.
- Trạng thái `inviteStatus` của phụ huynh: `not_invited`, `invited`, `activated`, `expired` (Plan S4-BE-02). Lời mời bị thu hồi tính là `not_invited`. Ở `roster` là phép gộp theo các phụ huynh của học viên.
- `redeem-code` nhận mã không phân biệt hoa thường; chỉ chặn ký tự `U`, còn `I`/`L`/`O` server tự đổi theo Crockford.

Đồng ý xử lý dữ liệu:

- `POST /consents` luôn thêm dòng mới (201), không bao giờ sửa dòng cũ; không có PUT/PATCH/DELETE. `acceptedAt`, `ip_hash` và user agent do server lấy, không nhận từ body. `termsVersion` phải là bản hiện hành, lệch → 409 `CONFLICT_STALE`.
- Thêm `GET /consents/status?role=` (ngoài Spec): trả bản điều khoản hiện hành và user đã đồng ý bản đó chưa. Cần cho màn đồng ý và guard S4-FL-09; web cũng dùng. Chưa có `forStudentId` (phụ huynh đồng ý cho con dưới 16 tuổi), vì vai trò Học sinh nằm ngoài Sprint 4.
- Không đòi membership vai trò đó khi ghi đồng ý, vì phụ huynh mới đồng ý trước khi nhận lời mời. `/family/**` thì đòi cả membership Phụ huynh lẫn đã đồng ý, nếu không → 403 `FORBIDDEN` hoặc `CONSENT_REQUIRED`.

`/family/**`:

- `GET /family/students/{id}/attendance?week=`: `week` là một ngày ISO bất kỳ trong tuần (mặc định tuần hiện tại), server lấy tuần Thứ Hai đến Chủ Nhật theo múi giờ tenant. Trả `summary` và `sessions[]` của tuần (có buổi hủy và buổi bù); không có ghi chú giáo viên. Không có endpoint lịch học riêng.
- Con không liên kết, của tenant khác hay không có đều 404 `NOT_FOUND`. `GET /family/students` chỉ trả các con đã liên kết, không có phone/email phụ huynh khác hay ghi chú.

Web Push (P1):

- `POST /web-push/subscriptions` nhận đúng dạng `PushSubscription.toJSON()`, upsert theo `endpoint`; `Idempotency-Key` tùy chọn như `push/register`. Thêm `POST /web-push/unsubscribe` để hủy khi đăng xuất (ngoài Spec). Không có endpoint đọc subscription. Khóa công khai VAPID web lấy từ cấu hình build, không có endpoint.

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
