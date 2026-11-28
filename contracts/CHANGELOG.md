# Lịch sử hợp đồng API

`contracts/openapi.json` sinh từ schema zod bằng `pnpm openapi:gen`; file này ghi endpoint thêm mới theo sprint. Chỉ thêm, không đổi endpoint cũ (CI chặn bằng `oasdiff`).

## Phụ huynh báo vắng trước + điểm danh trả thêm 2 trường (US-3.4, US-3.1 AC5, US-3.3; chỉ thêm, `oasdiff breaking` sạch)

- `GET /sessions/{id}/attendance`: mỗi `AttendanceItem` thêm `recordedByName: string|null` (tên người ghi bản đang lưu; "Sửa lần cuối bởi … lúc `syncedAt`", US-3.3) và `parentReport: {reason, note, reportedAt}|null` (báo vắng trước đang hiệu lực, để app điền sẵn "Vắng có phép", US-3.1 AC5). Chọn mức THEO TỪNG HỌC VIÊN thay vì `lastEditedByName`/`lastEditedAt` cả buổi: mỗi dòng có người ghi và `syncedAt` riêng, app suy "lần sửa cuối của buổi" bằng max, còn mức buổi sẽ sai khi nhiều người ghi các dòng khác nhau.
- `POST /family/absence-requests` (`sessionId`, `studentId`, `reason` `sick|family|other`, `note` ≤ 300): 201 tạo mới, 200 khi con đã có báo vắng hiệu lực cho buổi (trả bản đang có). `GET /family/absence-requests?studentId=`: báo vắng đang hiệu lực cho buổi chưa bắt đầu. `DELETE /family/absence-requests/{id}`: 204, hủy trước giờ bắt đầu, idempotent. Tên theo Technical Spec §5 (`absence-requests`, bảng `absence_requests`).
- Mã lỗi mới `ABSENCE_SESSION_STARTED` (409): buổi đã bắt đầu thì không báo hay hủy báo vắng (US-3.4 AC2). Buổi đã hủy dùng `SESSION_CANCELLED` có sẵn.
- Loại thông báo mới `student_absence_reported` (giáo viên nhận khi phụ huynh báo vắng): chưa khai vào `oneOf` của `Notification`, cùng nhóm ngoại lệ `oasdiff` đã chốt cho `payment_claim_*`; client bỏ qua `type` lạ.
- `AttendanceSyncResult.parentsToNotify`: chỉ đổi mô tả, hành vi không đổi: chỉ vắng KHÔNG phép mới báo phụ huynh, "vắng có phép" (kể cả do phụ huynh đã báo) không gửi lại (US-3.2 AC2).

## OTP_INVALID kèm số lượt thử còn lại (chỉ thêm `details`, không đổi schema; `oasdiff` sạch)

- Nhập sai mã OTP mà còn lượt → 401 `OTP_INVALID` kèm `details.attemptsLeft` (4, 3, 2, 1 theo số lượt đã sai từ cùng một IP; IPv6 gộp theo /64). Áp dụng cho mọi endpoint dùng OTP: `POST /auth/login`, `DELETE /me` (mục đích `delete_account`), `PUT/PATCH/DELETE /payout-accounts` (mục đích `payout_account`).
- Lượt sai thứ 5 từ cùng IP vẫn là 429 `OTP_LOCKED` kèm `details.retryAfterSec` như trước. Hai trường hợp khác vẫn trả 401 không kèm `attemptsLeft`: không có mã trong Redis (mã hết hạn hoặc đã tiêu) và mọi IP cộng lại vượt trần `maxFailsPerHour` lượt sai trong giờ.
- App hiện "Mã không đúng. Còn N lần thử." khi có `attemptsLeft`, thiếu trường thì lùi về "Mã không đúng.".
- Chưa khai `details` này vào OpenAPI (`ApiErrorWithDetails`); cần chạy `pnpm openapi:gen` nếu muốn tài liệu hoá.

## Dời buổi đã điểm danh (chỉ đổi hành vi server và mô tả, không đổi schema; `oasdiff` sạch)

- `POST /sessions/{id}/reschedule`: buổi `planned` đã có điểm danh → 409 `SESSION_HAS_ATTENDANCE` (như hủy), buổi giữ nguyên, không ghi outbox. App sửa điểm danh trước rồi mới dời. Thông điệp mã lỗi trong `error_codes.json` nói cả "hủy hoặc dời".

## Billing: việc theo dõi sau S5 (issue #179, chỉ đổi hành vi server, không đổi schema hay endpoint; `oasdiff` sạch)

- Trạng thái học viên khi chốt kỳ xét THEO KỲ từ lịch sử đổi trạng thái: bảng mới `student_status_history` (migration `0034_student_status_history`; trigger ghi một dòng mỗi lần `students.status` đổi thật, RLS như `students`). Trạng thái cuối kỳ = `to_status` của dòng cuối có ngày đổi (giờ tenant) ≤ cuối kỳ; không có dòng nào ≤ cuối kỳ thì `from_status` của dòng đầu; không có lịch sử (học viên đổi trước migration) thì trạng thái hiện tại. Học viên chuyển `left`/`paused` sau cuối kỳ M (giữa ngày 1 tháng M+1 và ngày chốt) vẫn bị tính kỳ M; `left` từ ngày L: chỉ tính buổi trước L (L = lần chuyển sang `left` gần nhất ≤ cuối kỳ); `paused`: chỉ buổi theo buổi đã dạy. Đổi nhiều lần (vd. active → paused 10/02 → active 05/03) xét đúng theo từng kỳ. Giới hạn: xét tại cuối kỳ, đổi rồi đổi lại ngay trong kỳ coi như không đổi.

- Catch-up: lỡ ngày chốt quá một tháng (worker dừng) thì job tạo MỌI kỳ còn thiếu, cũ → mới, trong một giao dịch của tenant (kỳ có tháng sau kỳ mới nhất đã có; tenant chưa có kỳ nào chỉ tạo kỳ mới nhất; tối đa 12 kỳ). Kỳ cũ tạo muộn vẫn có `closeDate`/`dueDate` như đã chốt đúng hạn; một lần chạy chỉ ghi MỘT sự kiện `billing_drafts_ready` cho cả tenant (payload: kỳ mới nhất có nháp chốt được, `draftCount` và `draftTotalAmount` cộng các kỳ). Kỳ không có nháp thì không tạo, nên tháng trống nằm TRƯỚC kỳ mới nhất đã có không được bù về sau. Idempotent: chạy lại không tạo gì mới.

- Trọn khóa (US-7.1 AC5): tổng buổi của khóa lấy theo cấu hình lớp (quy tắc lặp hằng tuần trong [`startDate`, `endDate`]), buổi còn lại = các buổi từ ngày học viên vào, thay vì đếm buổi đã sinh cuốn chiếu. Vd. khóa 24 buổi 3.600.000 đ, vào khi còn 16 buổi → 2.400.000 đ. `PATCH /classes/{id}` đã bắt `course` phải có `endDate` và quy tắc lịch nên đủ cấu hình; lớp cũ thiếu cấu hình (hoặc khóa dài hơn 731 ngày) giữ cách đếm buổi hiện có và job ghi cảnh báo. Giới hạn: tổng buổi tính theo quy tắc lặp HIỆN HÀNH (đổi quy tắc giữa khóa làm đổi tổng; buổi dời, nghỉ lễ, buổi bù không được tính riêng).

- Push và thông báo `billing_ready` ("Học phí tháng X đã sẵn sàng") tôn trọng giờ yên lặng như nhắc nợ: khung gửi 07:00–21:30 giờ tenant; job chốt kỳ chạy 02:00 nên sự kiện được hẹn tới 07:00 (ngoài khung thì tới 07:00 kế tiếp). Thông báo chỉ tạo (và hiện trong `GET /notifications`) lúc gửi; mỗi kỳ một thông báo, không gửi trùng. Không đổi schema thông báo.

## Ngoại lệ một lần: hợp nhất thông báo và not_marked

Hai thay đổi `oasdiff breaking` báo ERR, được Owner/TL chấp nhận MỘT LẦN vì chưa có bản app nào phát hành ra ngoài (xem "Đã chốt khi duyệt" ở Sprint 7). Sau PR này mọi thay đổi lại phải sạch `oasdiff` mà không cần ngoại lệ.

- `Notification` (`GET /notifications`): `oneOf` thêm 7 loại, payload theo schema zod sẵn có: `schedule_changed`, `billing_ready`, `invoice_issued`, `payment_recorded`, `payment_reminder`, `subscription_expiring` (payload `{ offsetDays: 7|1, currentPeriodEnd }`), `subscription_activated` (payload `{ source: bank_transfer, currentPeriodEnd }`). `notificationTypeSchema` thêm hai loại subscription. Client vẫn bỏ qua `type` lạ.
- `SessionNotChargedReason` thêm `not_marked` (issue #179). Server cài đặt thật: buổi theo buổi còn `planned` lúc chốt (chưa điểm danh) nay là dòng 0 đ `charged = false`, `notChargedReason = not_marked` (trước: `charged = true`, 0 đ). Migration `0033_billing_not_marked` nới CHECK `invoice_lines_not_charged_reason_check`; hóa đơn đã lập trước đó giữ nguyên (chưa có dữ liệu thật). Tổng tiền không đổi.
- Cơ chế bỏ qua đã gỡ: `contracts/oasdiff-ignore.txt` và nhánh `--err-ignore` trong `.github/workflows/ci.yml` đã xóa sau khi thay đổi vào `main` (nhánh đích đã chứa thay đổi nên `oasdiff` sạch). Từ đây mọi thay đổi hợp đồng phải sạch `oasdiff breaking`.

## Push FCM có chữ khay (chỉ đổi mô tả, không đổi schema)

Push FCM gửi thêm khối `notification` (tiêu đề + nội dung tiếng Việt chung theo `type`, không tên con, lớp, số tiền), giữ `data` `{ notificationId, type }`; kênh Android `attendance`, `billing`, `general`. Các dòng "data-only" cũ bên dưới đã sửa theo.

## Sprint 5 (S4-FL-10, S4-CT-01)

Thân hàm trả 501 `NOT_IMPLEMENTED` tới khi làm task backend tương ứng; schema đã validate thật. Không có bảng hay migration (S5-BE-01 làm cùng task backend).

| Endpoint | Task backend |
| --- | --- |
| `PUT /v1/enrollments/{id}/fee-override` | S5-BE-02 |
| `GET /v1/payout-accounts`, `POST /v1/payout-accounts`, `PATCH /v1/payout-accounts/{id}`, `DELETE /v1/payout-accounts/{id}` | S5-BE-02 |
| `GET /v1/billing-periods`, `GET /v1/billing-periods/{id}`, `GET /v1/invoices/{id}`, `POST /v1/invoices/{id}/adjustments` | S5-BE-06 |
| `POST /v1/billing-periods/{id}/issue`, `POST /v1/invoices/{id}/void` | S5-BE-07 |
| `GET /v1/family/invoices`, `GET /v1/family/invoices/{id}` (chi tiết cho phụ huynh, bổ sung ngoài Spec §5.4) | S5-BE-08 |

Làm rõ hợp đồng (S5-BE-07, chỉ đổi mô tả/example, không đổi kiểu): `POST /invoices/{id}/void` chưa hỗ trợ hóa đơn thay thế ở MVP. `createReplacementDraft = true` → 422 `VALIDATION_FAILED` (không hủy), `replacementInvoiceId` luôn null; hóa đơn thay thế = hủy rồi tạo lại bản nháp và chốt.

Thay đổi trên endpoint cũ (chỉ thêm trường, `oasdiff breaking` sạch):

- `PATCH /classes/{id}` nhận thêm `feeType`, `feeAmount`, `feeRules`. `Class` thêm ba trường cùng tên (null với lớp chưa có học phí). `POST /classes` chưa nhận học phí: tạo lớp rồi `PATCH`.
- `GET /classes/{id}/roster`: mỗi phần tử thêm `feeOverride` (khác null thì hiện nhãn "Giá riêng").
- Thông báo `billing_ready` (cho giáo viên) và `invoice_issued` (cho phụ huynh): mô tả payload trong description `GET /notifications`, có sẵn `billingReadyPayloadSchema` và `invoiceIssuedPayloadSchema` trong mã, nhưng CHƯA nằm trong `oneOf` của `Notification`, cùng lý do `oasdiff` như `schedule_changed` ở Sprint 4. Cần Owner/TL chọn một lần cho cả ba loại: chấp nhận ngoại lệ `response-property-one-of-added` rồi thêm vào union, hoặc giữ như hiện tại.

- `DELETE /payout-accounts/{id}` nhận thêm body tùy chọn `{ otpCode }` (S5-BE-02): bắt buộc khi xóa tài khoản chính còn tài khoản khác. `PATCH /payout-accounts/{id}` với `isPrimary = true` cũng cần `otpCode`. Giới hạn ghi 20 lần/phút tính theo IP.

Mã lỗi mới: `PAYOUT_ACCOUNT_MISSING` (422), `INVOICE_IMMUTABLE` (409); cả hai đã có tên trong Spec §5.6. Repo chỉ có `contracts/error_codes.json` là nguồn, không có bước sinh mã; app và web sinh hằng số từ file này.

Quy ước tiền (áp cho mọi endpoint ở trên):

- Số nguyên đồng (VND), không float, không đơn vị nghìn; `libs/core/src/money.ts` giữ `vndSchema` dùng chung. Tên trường `<ý nghĩa>Amount` (`feeAmount`, `totalAmount`, `draftTotalAmount`); dòng hóa đơn và dòng điều chỉnh dùng `amount`; phần trăm miễn giảm là `percent` (1 đến 100). Trần 100 tỷ đồng. Dòng, điều chỉnh và miễn giảm có dấu (`signedVndSchema`); `totalAmount` luôn ≥ 0.
- Luật làm tròn là luật nghiệp vụ (US-7.1 AC6), ghi trong mô tả schema: mọi dòng có chia tỷ lệ làm tròn tới 1.000 đ, từ 500 đ trở lên làm tròn lên. Đơn giá nhập vào (`feeAmount` > 0, không bắt buộc là bội của 1.000) và dòng điều chỉnh tay giữ nguyên số nhập.

Quyết định khi soạn (cần TL chốt nếu muốn khác):

Học phí lớp và mức riêng:

- Học phí chỉ đặt qua `PATCH` (Plan ghi "trong `PATCH /classes/{id}`"). `feeType` và `feeAmount` cùng đặt hoặc cùng xóa (`null`); `feeRules` thay toàn bộ quy tắc, trường thiếu lấy mặc định (vắng có phép và không phép đều tính, không trừ buổi hủy, 1 đợt). `installments` > 1 chỉ với `course`. Đổi cấu hình chỉ áp dụng từ kỳ chưa chốt tiếp theo (US-1.2 AC4).
- `PUT /enrollments/{id}/fee-override` thay toàn bộ mức riêng: `feeAmount`, `installments`, ba công tắc quy tắc và `discounts` (tối đa 5 khoản, mỗi khoản có `description` và `percent` hoặc `amount`, theo Spec §4.4 `recurring_discounts`). Trường `null` hoặc thiếu là kế thừa lớp; `discounts` rỗng là không miễn giảm; `{}` xóa mức riêng. Phụ thu thuộc US-7.8 (P1).
- Vai trò: mọi endpoint giáo viên dùng `tenant_owner`, vì MVP gộp giáo viên và chủ tenant (`teacher`, `accountant` chưa phát hành membership).

Tài khoản nhận tiền:

- CRUD theo Spec §4.4: `bankBin` đúng 6 chữ số, `accountNo` 6 đến 19 chữ số, `accountName` ≤ 50 ký tự, `isPrimary`. Tối đa 5 tài khoản mỗi tenant. Tài khoản đầu tiên tự là chính; xóa tài khoản chính thì tài khoản tạo sớm nhất còn lại lên làm chính. Danh sách chỉ trả `accountNoMasked` (4 số cuối), số đầy đủ không trả lại; `POST` và `PATCH` đổi `bankBin` hoặc `accountNo` bắt buộc `otpCode` (OTP gửi qua `POST /auth/otp/send` với `purpose = payout_account`, sai → 401 `OTP_INVALID`). **Mặc định này chờ Owner chốt.**
- Server kiểm định dạng BIN. `bankName` của `payout` tra từ bảng BIN phía server, null nếu BIN không có trong bảng; bảng này chưa có (xem "Chờ chốt").

Kỳ thu và hóa đơn:

- Trạng thái hóa đơn khai đủ enum Spec §4.3 (`draft`, `issued`, `pending_confirmation`, `partially_paid`, `paid`, `void`) để Sprint 6 không thêm giá trị vào phản hồi; Sprint 5 chỉ phát sinh `draft`, `issued`, `void`. Loại dòng cũng khai đủ (`carry_over`, `prev_adjustment`, `surcharge` chưa dùng).
- `GET /invoices/{id}`: `lines` là nguồn duy nhất và là snapshot lúc tính, không có mảng `sessions` riêng. Mỗi dòng có `charged`, `notChargedReason` (4 giá trị không tính), `sessionId`, `sessionDate`, `className`, `adjustmentReason` (chỉ dòng điều chỉnh). Đối chiếu `invoice-calculator.ts` trên main: kiểu theo buổi sinh mỗi buổi một dòng `session`, kể cả buổi hủy và buổi bù 0 đ; kiểu theo tháng và trọn khóa không sinh dòng buổi mà sinh MỘT dòng gốc (`monthly` đã trừ phần buổi hủy khi bật `deductCancelled`, hoặc `course_installment`), rồi các dòng `discount` và `manual_adjustment`. Muốn tách phần trừ buổi hủy thành dòng riêng thì phải sửa calculator. Dòng không đổi sau phát hành. Một hóa đơn gộp mọi lớp của học viên trong kỳ.
- Kỳ `closed` khi không còn bản nháp nào có số tiền > 0 (bản nháp 0 đ không gửi nên còn lại). `GET /billing-periods/{id}` kèm `invoices` phân trang offset.
- `POST /invoices/{id}/adjustments`: `amount` ≠ 0 có dấu, bắt buộc `description` và `adjustmentReason`, chỉ khi còn `draft`, ngược lại 409 `INVOICE_IMMUTABLE`. Tối đa 20 dòng điều chỉnh mỗi hóa đơn (vượt → 422). Tổng âm bị cắt về 0, phản hồi có `clampedAmount` (phần âm chuyển kỳ khi có US-7.6). Chưa có endpoint xóa dòng điều chỉnh: sửa nhầm thì thêm dòng ngược dấu.

Phát hành và hủy:

- `issue` nhận `{ invoiceIds }` (`null` là tất cả, đúng ví dụ Spec §5.4) và trả `issuedCount`, `skipped` (`ZERO_AMOUNT`, `NOT_DRAFT`), `totalAmount`, `invoices` (mã, `transferNote`, `qrPayload`, hạn). Trả 200, không phải 201. Thiếu tài khoản nhận tiền → 422 `PAYOUT_ACCOUNT_MISSING` và không phát hành hóa đơn nào. `Idempotency-Key` bắt buộc; sự kiện outbox `invoice_issued` sinh thông báo và email.
- Mã hóa đơn `TH-xxxxxx` (6 ký tự Crockford, theo ví dụ `TH-25K7Q9` của Spec §4.3); nội dung chuyển khoản `TH xxxxxx` (thay gạch bằng khoảng trắng), `[A-Z0-9 ]`, ≤ 25 ký tự. Kế hoạch ghi "`TH <mã>`": lấy `<mã>` là phần sau `TH-`.
- `void` nhận `reason` bắt buộc và `createReplacementDraft` (mặc định false; **chờ TL xác nhận**). Spec §5.4 ghi "tùy chọn phát hành hóa đơn thay thế" còn Plan §2.6 ghi Sprint 5 chỉ hủy, thay thế là "tạo lại bản nháp rồi chốt"; không có endpoint nào tạo lại bản nháp, nên cờ này tạo bản nháp thay thế (`replacesInvoiceId`, và hóa đơn hủy có `replacementInvoiceId`) trong cùng giao dịch; kỳ chuyển lại `drafting` nếu đang `closed`. Bỏ cờ nếu TL muốn đúng Plan và chấp nhận thiếu đường tạo lại. Chỉ hủy `issued`; hủy lại hóa đơn đã `void` trả 200; `draft` hoặc hóa đơn đã có thanh toán → 409 `CONFLICT_STALE`.
- `qrPayload` do `buildVietQrPayload` (spike #63, S2-BE-VQR) sinh; hàm này chưa có trong repo.

Phụ huynh (`/family/invoices`):

- Chỉ vai `parent` và đã đồng ý điều khoản, nên học sinh gọi nhận 403 `FORBIDDEN` và không thấy học phí (US-0.6 AC3). Phân trang con trỏ; không bao giờ có bản nháp; hóa đơn đã hủy vẫn có (`status = void`, `qrPayload = null`) để link trong thông báo cũ không 404. Hóa đơn của con không liên kết, của tenant khác hay bản nháp đều 404.
- Dữ liệu phụ huynh đã lọc: không có lý do hủy, lý do điều chỉnh, `sessionId`, hay điểm danh chi tiết; dòng có `className`. `payout` (kèm `bankName`) đủ để chép số tài khoản nếu quét QR không được (rủi ro R16), và là null khi hóa đơn `void`. `/family/invoices` lọc thêm theo `status`.
- Hợp đồng chưa có "thanh toán", "biên nhận", `receivables` (Sprint 6, FL2 soạn ở S5-FL-09).

Trọn khóa, thông báo và giới hạn:

- `PATCH` với `feeType = course` mà lớp không xác định được tổng số buổi (thiếu `endDate` hoặc không có quy tắc lịch) → 422 `VALIDATION_FAILED` ở `feeType`. `Invoice` có `installmentNo` và `installmentCount` (null với kiểu khác). Đợt n là kỳ thứ n kể từ kỳ đầu tiên học viên vào lớp; hết số đợt thì không sinh thêm hóa đơn trọn khóa cho ghi danh đó. Trần số đợt 1 đến 36, khớp calculator.
- Thông báo `billing_ready`, `invoice_issued`: push FCM có chữ khay chung theo loại, `data` chỉ `notificationId`, `type`, không tên con, không số tiền; email `invoice_issued` có tiêu đề cố định, không chứa tên con.
- Route ghi tiền (`issue`, `void`, `adjustments`, `fee-override`, ghi `payout-accounts`) giới hạn 20 lần/phút/user, vượt → 429 `RATE_LIMITED`. `OtpPurpose` thêm `payout_account` ở `POST /auth/otp/send`.
- Phản hồi `Invoice` thêm `replacementInvoiceId`, `installmentNo`, `installmentCount`, `clampedAmount`.

Chờ chốt:

- Ngày chốt và hạn thanh toán của kỳ: chưa có endpoint cấu hình; hợp đồng chỉ đọc `closeDate`, `dueDate`. Mặc định do PO quyết (kỳ là tháng dương lịch theo PRD; ngày chốt và hạn chưa có số), cần chốt trước S5-BE-05.
- Đã làm: ba loại thông báo (`schedule_changed`, `billing_ready`, `invoice_issued`) đã vào `oneOf` của `Notification` (xem "Ngoại lệ một lần").
- Bảng BIN NAPAS: chưa rõ nằm ở server hay client. Hợp đồng giả định server giữ để điền `bankName`.
- `createReplacementDraft` ở `void` (xem trên) và OTP khi đổi tài khoản nhận tiền (xem trên).

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
- Thông báo loại `schedule_changed`: payload mô tả trong description `GET /notifications` và có sẵn `scheduleChangedPayloadSchema` trong mã, nhưng CHƯA nằm trong `oneOf` của `Notification`, vì `oasdiff` báo `response-property-one-of-added` (ERR) so với Sprint 3. Cần Owner/TL chọn: chấp nhận ngoại lệ (Sprint 3 chưa có client phát hành) rồi thêm một dòng vào union, hoặc giữ như hiện tại.
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
- Thông báo `schedule_changed` (xem mục trên) có `change` (`rescheduled`/`cancelled`/`makeup`), giờ mới/cũ, lý do; deepLink `teachhub://sessions/{sessionId}`.

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
- Push FCM có khối `notification` (tiêu đề + nội dung chung theo loại, không tên con, lớp, số tiền) và `data` chỉ có `notificationId`, `type`; kênh Android `attendance`, `billing`, `general`. App gọi `GET /notifications` sau khi mở.
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

Làm rõ (S2-BE-05, chỉ đổi mô tả): `guardians[].id` phải là phụ huynh đang liên kết với chính học viên đó, sai → 422 ở `guardians.N.id`; `POST /v1/students` không nhận `id`.

Làm rõ (S2-BE vòng sửa, chỉ thêm mô tả lỗi): `POST /v1/classes` và `POST /v1/students` khai thêm 409 `CONFLICT_STALE` (`id` do client gửi đã tồn tại); `PATCH /v1/classes/{id}` trên lớp đã lưu trữ → 409 `CONFLICT_STALE`; `POST /v1/center-waitlist` khai thêm 429 `RATE_LIMITED` (5 request/giờ/IP).

Hành vi `Idempotency-Key` (không đổi shape): băm yêu cầu nay gồm cả tham số đường dẫn và tenant; cùng key dùng cho đích khác (vd. archive lớp khác) → 422 `IDEMPOTENCY_KEY_REUSED`. Kết quả lưu quá 48 giờ bị worker dọn.

Lệch có chủ ý so với Spec:

- `POST /v1/classes` trả lớp trần kèm `warnings: [{ code, message }]` (mặc định rỗng). Không nhận lịch lặp inline như ví dụ ở Spec §5.4 (lịch đặt qua `PUT /classes/{id}/schedule-rules`), và chưa có `409 WARNING_ACK_REQUIRED`.
- `GET /v1/sessions` giới hạn khoảng 62 ngày và không phân trang, ngoại lệ so với quy ước §5.5. `from` và `to` là ngày theo múi giờ tenant, bao gồm hai đầu.
- Mã trùng học viên theo Plan (`STUDENT_POSSIBLE_DUPLICATE`), không theo tên `DUPLICATE_STUDENT_SUSPECTED` ở Spec §5.6.

Ghi chú:

- `POST /v1/auth/sso/apple` (S2-BE-01), quy ước nonce: client sinh nonce thô, gửi nonce **thô** trong body và gửi SHA-256(nonce) dạng hex cho Apple. Server băm nonce thô rồi so với claim `nonce`. `aud` là bundle ID đọc từ `APPLE_BUNDLE_ID`; chỉ nhận RS256/ES256. Mỗi `identityToken` dùng được một lần (dùng lại → 401), nên client lỗi mạng phải xin token Apple mới thay vì gửi lại.
- Route `/v1/admin/**` trả 401 cho tới khi có AdminGuard (JwtAuthGuard toàn cục vẫn chặn). `GET /v1/admin/legal-articles` là bổ sung ngoài Spec §5.4, để trang admin liệt kê bài.
- Endpoint `files` chuyển sang task US-4.1, Sprint 2 chưa làm.

Route `/v1/admin/**` dùng ba security scheme riêng, không Bearer: `x-admin-secret`, `x-admin-user-id` (bắt buộc, không rỗng), `x-admin-permissions` (đúng một URI quyền cho thao tác: `/teachhub/admin/bank-transfer`, `/teachhub/admin/legal-articles` hoặc `/teachhub/admin/support`).

## Sprint 6 "Thu tiền" (S5-FL-09, S5-CT-01)

Thân hàm trả 501 `NOT_IMPLEMENTED` tới khi làm task backend tương ứng; schema đã validate thật. Không có bảng hay migration (S6-BE-01 làm cùng task backend). `oasdiff breaking` so với main: sạch.

| Endpoint | Task backend |
| --- | --- |
| `POST /v1/invoices/{id}/payments`, `GET /v1/invoices/{id}/payments`, `POST /v1/payments/{id}/void` | S6-BE-02 |
| `GET /v1/students/{id}/ledger` (sổ học viên, số dư chuyển kỳ; dòng `carry_over` và `prev_adjustment` trong bản nháp là việc của `InvoiceCalculator`) | S6-BE-03 |
| `GET /v1/tenant/settings/dunning`, `PUT /v1/tenant/settings/dunning`, `GET /v1/tenant/settings/dunning/preview`, `PUT /v1/enrollments/{id}/dunning`, `GET /v1/invoices/{id}/dunning` | S6-BE-04 |
| `GET /v1/receivables`, `GET /v1/receivables/{studentId}` (T11, P1) | S6-BE-05 |

Thay đổi trên endpoint cũ (chỉ thêm trường hoặc đổi mô tả, `oasdiff breaking` sạch):

- `Invoice` (`GET /invoices/{id}` và các phản hồi chứa nó) thêm `paidAmount`, `remainingAmount`. `FamilyInvoiceSummary` (cả `GET /family/invoices`) thêm hai trường cùng tên; `FamilyInvoice` thêm `payments` (biên nhận, không có lý do hủy hay ghi chú). Sprint 5 chưa có thanh toán nên mapper hiện trả `0`, `totalAmount` và `[]` (đúng thực tế); S6-BE-02 thay bằng dữ liệu thật.
- Trạng thái hóa đơn `partially_paid` và `paid` bắt đầu phát sinh (enum đã có từ Sprint 5). `pending_confirmation` vẫn chưa (US-7.7 bị cắt).
- Dòng `carry_over` (có dấu: dương "Nợ kỳ trước", âm trừ tiền trả thừa) và `prev_adjustment` bắt đầu phát sinh trong `lines` (enum đã có từ Sprint 5).
- `GET /billing-periods`: mô tả ngày chốt đúng như đang chạy (kỳ tháng M chốt ngày `billingCloseDay` của tháng M+1, mặc định 1) thay cho "tenant có ngày chốt hôm nay" (issue #179).
- `DELETE /payout-accounts/{id}`: `requestBody.required` là `false` (server nhận không body), sửa ở controller bằng `@ApiBody({ required: false })`, openapi.json do `pnpm openapi:gen` sinh.
- `GET /notifications`: mô tả thêm hai loại `payment_recorded` và `payment_reminder` (cho phụ huynh), cùng cách với `billing_ready`/`invoice_issued`: có schema payload trong mã nhưng CHƯA nằm trong `oneOf` của `Notification`.

Mã lỗi mới: `INVOICE_NOT_PAYABLE` (409, hóa đơn `draft`/`void`/đã `paid` không ghi thanh toán được). Hủy thanh toán và các lỗi còn lại dùng mã có sẵn (`VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT_STALE`, `RATE_LIMITED`).

Quyết định khi soạn (cần TL chốt nếu muốn khác; tài liệu không nói rõ nên chọn phương án đơn giản):

Thanh toán:

- `POST /invoices/{id}/payments` trả 201 với `PaymentResult` (`payment`, trạng thái và số liệu hóa đơn sau thao tác, `overpaidAmount`, `dunningCancelled`). Không có cờ "thu đủ" riêng: thu đủ = `amount` bằng số còn nợ, app điền sẵn số đó khi bấm "Đã thu đủ". Bỏ `revenueYtd` và `taxAlerts` khỏi ví dụ Spec §5.4 vì US-9.5 AC2 đến AC4 đã cắt khỏi Sprint 6 (thêm trường vào phản hồi sau này không phá client).
- Trả thừa được nhận (US-7.6 AC2 cần tiền trả thừa): hóa đơn `paid`, phần thừa vào `student_ledger`. Hóa đơn đã `paid` không nhận thêm thanh toán → 409 `INVOICE_NOT_PAYABLE`. `paidOn` mặc định hôm nay theo múi giờ tenant, phải từ ngày phát hành hóa đơn (múi giờ tenant) đến hôm nay, ngoài khoảng đó → 422 `VALIDATION_FAILED` ở `paidOn` (S6-BE-02, chỉ siết mô tả). Có `note` tùy chọn ≤ 300 ký tự.
- `POST /payments/{id}/void` trả 200 cùng `PaymentResult`; hủy lại thanh toán đã hủy vẫn 200 (như hủy hóa đơn). Hủy sau khi phần trả thừa đã bị trừ vào hóa đơn kỳ sau vẫn cho phép, sổ học viên có thể thành nợ. Hóa đơn còn nợ trở lại thì lập lại mốc nhắc chưa tới. Không báo phụ huynh khi hủy.
- `recordedBy`/`voidedBy` của `Payment`: tên là ảnh chụp lúc ghi/hủy, vẫn giữ sau khi tài khoản bị xóa (S6-BE-02, chỉ đổi mô tả; `voidedBy` null khi chưa hủy).
- Biên nhận cho phụ huynh nằm trong `GET /family/invoices/{id}` (`payments`), không có endpoint riêng; thông báo `payment_recorded` mở đúng hóa đơn đó. Không có số biên nhận riêng.
- Sổ doanh thu (US-9.5 AC1) chỉ ghi, chưa có endpoint đọc: `GET /compliance/revenue-book` của Spec thuộc E9 cùng AC2 đến AC4.

Sổ học viên và số dư chuyển kỳ:

- `GET /students/{id}/ledger` trả `balanceAmount` có dấu (dương nợ cũ, âm trả thừa), `debtAmount`, `creditAmount` và các dòng sổ phân trang. Spec §4.4 chỉ nói `debit`, `credit`, `kind` nên tên `kind` là đề xuất: `unpaid_carried`, `overpayment`, `prev_adjustment`, `applied_to_invoice`, `payment_void`. Đổi mô hình sổ thì chỉ đổi enum phản hồi này.
- Bản nháp kỳ sau thể hiện số dư bằng dòng `carry_over` có dấu trong `lines` (không thêm trường mới vào `Invoice`).

Nhắc nợ:

- Lịch tính bằng ngày so với hạn: `offsetsDays` mặc định `[-1, 0, 3, 7]` (đúng US-7.5 AC1), tenant đổi được, 1 đến 6 mốc từ -7 đến 30, tăng dần. Lịch mới chỉ áp cho hóa đơn phát hành sau đó. Giờ gửi cố định 07:00 đến 21:30 (job của Spec), chưa có cấu hình riêng; giờ yên lặng chung (US-6.5) chưa có endpoint ở repo này.
- `PUT /enrollments/{id}/dunning` theo đúng Spec và Plan, nhưng US-7.5 AC3 nói theo học viên mà hóa đơn gộp mọi lớp: học viên chỉ không được nhắc khi mọi ghi danh đang mở đều tắt. App bật/tắt theo học viên bằng cách gọi cho từng ghi danh (danh sách ở `GET /receivables/{studentId}`).
- Không có endpoint tắt nhắc riêng một hóa đơn (US không đòi); `GET /invoices/{id}/dunning` chỉ đọc trạng thái và lý do không còn nhắc. `GET /tenant/settings/dunning/preview` là thêm ngoài Spec §5.4 cho US-7.5 AC4 ("xem trước mẫu tin", S6-FL-04).
- Thông báo nhắc là `payment_reminder`, do hệ thống đứng tên, push như các loại tiền khác (chữ khay chung, không số tiền).

Công nợ (T11):

- `GET /receivables` đúng Spec: `agingBucket` là `0-30`, `31-60`, `over-60` (không dùng `60+` vì `+` trong query bị giải mã thành dấu cách), lọc thêm `classId`, sắp `sortField` = `amount` (mặc định, giảm dần), `overdueDays`, `studentName`; phân trang offset. `summary` có tổng ba nhóm và không bị lọc theo `agingBucket`. Hóa đơn chưa tới hạn tính vào nhóm `0-30`.
- Lịch sử một học viên (US-8.3 AC3) là `GET /receivables/{studentId}` (Plan S6-BE-05 không đặt đường dẫn): hóa đơn tối đa 24, thanh toán và nhắc nợ tối đa 50 bản ghi mới nhất, chưa phân trang.
- Vai trò mọi endpoint mới: `tenant_owner` (MVP gộp giáo viên và chủ tenant), ghi tiền giới hạn 20 lần/phút/user.

Chờ chốt:

- Đã làm: issue #179, lý do `not_marked` cho buổi chưa điểm danh (`SessionNotChargedReason`) đã thêm, kèm `payment_recorded`, `payment_reminder` vào `oneOf` (xem "Ngoại lệ một lần"). Trước đây chưa thêm vì `oasdiff` báo `response-property-enum-value-added`; Owner/TL đã chấp nhận ngoại lệ.
- Hủy hóa đơn đã có thanh toán (Sprint 5 mô tả 409): hiểu là có thanh toán còn hiệu lực; nếu muốn khác thì S6-BE-02 báo lại.

Sửa sau review (PR #185):

- `remainingAmount` (`Invoice`, `FamilyInvoiceSummary`) = 0 khi hóa đơn `void` hoặc `draft`; trạng thái khác = max(0, `totalAmount` − `paidAmount`). Hai mapper tạm trả đúng như vậy, có test hóa đơn hủy cho giáo viên và phụ huynh.
- `Payment` thêm `recordedBy` và `voidedBy` (`{ id, name }`, nullable); chỉ ở phản hồi của chủ tenant, không có trong `FamilyPayment`. `PaymentResult` bỏ `invoiceId` thừa (đã có `payment.invoiceId`).
- `GET /invoices/{id}/payments`: hóa đơn `void` vẫn trả danh sách cũ (gồm thanh toán đã hủy), bản nháp → 404.
- Hủy thanh toán đã hủy (khóa mới) → 200 bản hiện tại, giữ `voidReason`, `voidedBy` ban đầu; cùng khóa → phát lại. Hóa đơn `paid` → 409 `INVOICE_NOT_PAYABLE`, tiền nhận thêm ghi vào kỳ sau. Mô tả hai route ghi nêu rõ `IDEMPOTENCY_IN_PROGRESS` (409) và `IDEMPOTENCY_KEY_REUSED` (422); hai mã này vốn đã được `@ApiIdempotencyKey()` khai vào phản hồi.
- `GET /receivables` thêm `q` (tên học viên, không dấu); `summary` tính theo `classId` và `q` đang áp, không theo `agingBucket` (vì là trục chia nhóm, nếu lọc thì hai nhóm kia luôn 0).
- Biên nhận phụ huynh: phụ huynh khác → 404. `PUT /enrollments/{id}/dunning` gọi lặp cùng giá trị → `cancelledCount = 0`.

Đã chốt (S6-BE-03, S6-BE-05; thêm trường `carriedAmount` vào phản hồi hóa đơn, còn lại chỉ đổi mô tả; `oasdiff breaking` sạch):

- Mô hình số dư chuyển kỳ: kết chuyển tại thời điểm PHÁT HÀNH (chi tiết ở đầu `billing-period.ts`, D6, D7). `billing.close` chỉ tạo bản nháp có dòng `carry_over` XEM TRƯỚC (Σ còn nợ hóa đơn kỳ trước + số dư sổ), không ghi sổ, không đụng hóa đơn cũ; `GET /invoices/{id}` và `GET /billing-periods/{id}` tính lại xem trước theo số liệu hiện tại (không ghi), `POST /invoices/{id}/adjustments` làm mới dòng rồi tổng = max(0, Σ dòng). `POST /billing-periods/{id}/issue` (một giao dịch, khóa hóa đơn cũ) tính lại số dư dưới khóa, ghi `unpaid_carried` (nợ, gắn hóa đơn cũ), cộng `carriedAmount` của hóa đơn cũ, đặt dòng `carry_over` và `totalAmount` chốt, ghi `applied_to_invoice` (đối ứng). Σ dòng ngoài `carry_over` = 0 (vd. miễn giảm 100%) → `ZERO_AMOUNT`, không phát hành, không kết chuyển (US-1.3 AC3). Có phát sinh nhưng số dư sổ trả đủ (hoặc điều chỉnh tay âm vượt phát sinh) vẫn được chốt: `totalAmount` 0, trạng thái `paid`, có mã, `qrPayload` là chuỗi rỗng (đổi sang nullable ở phản hồi `issue` bị oasdiff coi là breaking nên giữ chuỗi rỗng; `GET /invoices/{id}` trả null), tính vào `issuedCount`/`invoices`, không nhắc nợ, không push `invoice_issued`; `applied_to_invoice` ghi nợ đúng phần phát sinh được số dư trả (hoặc ghi có phần âm), phần dư ở lại sổ. `GET /invoices/{id}` của nháp trả dòng `carry_over` xem trước với `id` ổn định. Chênh lệch điểm danh sửa sau phát hành (kể cả buổi nay bị hủy hoặc đã xóa) thành dòng `prev_adjustment` ở bản nháp mới, không đi qua sổ; dòng này cũng là xem trước (GET/`adjust` tính lại) và `issue` tính lại dưới khóa nên hai nháp chưa chốt không điều chỉnh trùng một buổi. Khi phát hành, kỳ chỉ đóng khi không còn nháp chốt được theo giá trị tính lại (mọi nháp còn lại của kỳ được làm mới xem trước). Bản nháp không có phát sinh (Σ dòng ngoài `carry_over` = 0) lưu `totalAmount` 0, không chặn việc đóng kỳ và không tính vào thông báo bản nháp sẵn sàng.
- `Invoice`, `FamilyInvoiceSummary` (và `FamilyInvoice`) thêm `carriedAmount`: phần còn nợ đã chuyển sang hóa đơn kỳ sau (0 nếu chưa). `remainingAmount` = max(0, `totalAmount` − `paidAmount` − `carriedAmount`) nên T11 chỉ tính nợ ở hóa đơn mới, không đếm hai lần.
- `GET /receivables`: nợ ròng theo học viên = max(0, Σ `remainingAmount` các hóa đơn còn nợ + số dư sổ): số dư âm (trả thừa) giảm nợ, số dư dương (nợ ở sổ, vd. hủy thanh toán sau khi trả thừa đã được trừ) tăng nợ; nợ ròng 0 thì không có dòng; học viên chỉ có nợ ở sổ vẫn có dòng (`openInvoiceCount` ≥ 1). Số dư âm bù vào hóa đơn cũ nhất trước (FIFO): hạn cũ nhất, tuổi nợ và `openInvoiceCount` tính theo hóa đơn còn nợ sau khi bù. Nhóm tuổi nợ và `summary` theo nợ ròng. `GET /receivables/{studentId}` thêm `invoiceOutstandingAmount` (Σ `remainingAmount` hóa đơn còn nợ); `outstandingAmount` là nợ ròng, `ledgerBalanceAmount` là số dư sổ. Tuổi nợ dùng hạn cũ nhất của khoản nợ gốc: hóa đơn nhận khoản chuyển kỳ mang hạn nợ cũ nhất của các hóa đơn nguồn, nên nợ chuyển nhiều kỳ vẫn vào nhóm `over-60`.
- Thanh toán trên hóa đơn đã chuyển nợ: còn thu được phần `remainingAmount` (hủy khoản thu thì nợ quay lại đúng phần chưa chuyển); hết còn nợ → 409 `INVOICE_NOT_PAYABLE`, thu quá phần còn nợ → 422 `VALIDATION_FAILED`. Hủy hóa đơn đã chuyển nợ hoặc mang dòng `carry_over` ≠ 0 → 409 `CONFLICT_STALE` (chưa hỗ trợ trả khoản chuyển kỳ về).
- `GET /receivables/{studentId}`: `reminders` rỗng và `dunningEnabled` luôn `true` tới khi S6-BE-04 có bảng nhắc nợ.

Đã chốt (S6-BE-04, nhắc nợ; hợp đồng không đổi):

- Giờ gửi mỗi mốc cố định 09:00 giờ tenant của ngày (hạn + `offsetDays`); job `billing.dunning` chạy mỗi 15 phút và chỉ gửi trong khung 07:00 đến 21:30 giờ tenant, ngoài khung thì dồn sang khung kế.
- Job nghỉ lâu hoặc khung giờ dồn nhiều mốc cho cùng một hóa đơn: chỉ gửi mốc muộn nhất, các mốc sớm hơn bị hủy (không dội nhiều tin cùng lúc).
- Hóa đơn còn nợ thật nhưng chưa có mốc nào (phát hành trước khi có tính năng, hoặc lúc đó tenant/học viên tắt nhắc rồi bật lại) được job tự lập các mốc tương lai theo lịch tenant hiện hành, không tạo mốc quá khứ.
- Đổi lịch `offsetsDays` không áp cho mốc đã lập; tắt rồi bật lại nhắc của tenant không lập lại mốc đã hủy của hóa đơn cũ. Bật lại nhắc của học viên và hủy thanh toán lập lại các mốc chưa tới đã hủy.
- Thông báo `payment_reminder` do hệ thống đứng tên "DayHoc nhắc…"; trước khi gửi, hệ thống kiểm lại nợ thật (`total − paid − carried`), hết nợ hoặc hóa đơn hủy thì bỏ qua. Email có số còn nợ, hạn và đường dẫn mở đúng hóa đơn (`teachhub://invoices/{id}`); push chỉ chữ chung.

## Sprint 7 "Báo cáo và gói Pro" (S6-FL-06, S6-CT-01)

Thân hàm trả 501 `NOT_IMPLEMENTED` tới khi làm task backend tương ứng; schema đã validate thật. Không có bảng hay migration mới (`subscriptions`, `plans`, `subscription_events`, `bank_transfer_orders` đã có từ Sprint 2; `revenue_ledger` từ Sprint 6). Phạm vi theo R-10 (Plan §2.7 "Lộ trình": `subscription`, `reports`, `admin`, IAP, T12, T14 dồn sang Sprint 7–8).

| Endpoint | Story | Ưu tiên | Màn |
| --- | --- | --- | --- |
| `GET /v1/reports/month-overview` | US-8.1, US-7.4 AC3 | P0 | T12 |
| `GET /v1/reports/payments` (bổ sung ngoài Spec §5.4) | US-8.1 AC2, AC3 | P0 | T12 |
| `GET /v1/reports/revenue-by-class`, `GET /v1/reports/revenue-12m` | US-8.2 | P0 | T12 |
| `GET /v1/plan-usage` | US-0.7, US-0.8 | P0 | T14, tab Thêm |
| `POST /v1/subscription/trial` | US-0.8 AC1 | P0 | T14 |
| `POST /v1/subscription/bank-transfer-orders` (chỉ web, R6) | US-0.8 AC3 | P0 | T14a |
| `POST /v1/webhooks/revenuecat` | US-0.8 AC2 | P0 | (RevenueCat gọi) |

Thay đổi trên endpoint cũ (chỉ thêm, `oasdiff breaking` sạch):

- `POST /invoices/{id}/adjustments` nhận thêm `kind` tùy chọn (`manual_adjustment` mặc định, `surcharge`) cho US-7.8 AC2 (P1): phụ thu một lần, `amount` > 0, dòng hóa đơn `surcharge`. Thân hàm hiện có chưa đọc `kind`, nên tới khi backend làm, `surcharge` rơi về `manual_adjustment` dương (cùng số tiền): task backend phải đọc `kind`. AC1 (giảm trừ cố định) đã có ở `PUT /enrollments/{id}/fee-override`, AC3 (tổng âm về 0) đã có.
- Thêm security scheme `revenuecatSecret` (header `Authorization`) trong `components.securitySchemes`.

Mã lỗi mới: `TRIAL_ALREADY_USED` (422, đã có tên trong Spec §5.6). `PLAN_LIMIT_EXCEEDED`, `FEATURE_REQUIRES_PRO`, `READONLY_PLAN_LIMIT` (402) đã có từ trước; `POST /classes` và `POST /students` đã khai 402 nên không đổi gì ở US-0.7.

Quyết định khi soạn (cần TL chốt nếu muốn khác):

Phạm vi:

- **Không đưa `admin`**: `/v1/admin/**` (xác nhận chuyển khoản, bài quy định, tra cứu hỗ trợ) đã có trong hợp đồng từ Sprint 2 (S1-CT-02) và là BFF của repo `teachhub-admin`, không app Flutter hay web giáo viên nào gọi. Sprint 7 chỉ làm đầu giáo viên của luồng chuyển khoản (tạo đơn), đầu admin xác nhận đã có sẵn.
- **Để Sprint 8**: US-7.7 `payment_claims` (P1): cần tải ảnh biên lai qua `files` (`POST /files/upload-urls`, `/complete`), module này chưa có trong hợp đồng và Spec chỉ ghi bảng, chưa có endpoint. Hóa đơn `pending_confirmation` đã có sẵn trong enum. US-9.5 AC2–AC4 (mục Thuế, thanh tiến độ ngưỡng, cảnh báo 80%, `tax_threshold_alerts`, `GET /compliance/revenue-book`): Spec chỉ ghi một dòng bảng và một dòng endpoint, Plan gắn vào E9 Tuân thủ (T13); đã có `revenue_ledger` nên không mất dữ liệu. US-8.4 (`GET /reports/attendance`), US-8.5 (`at-risk-students`, `POST /students/{id}/contacted`, ô nguy cơ nghỉ T12a): P1, phụ thuộc cảnh báo vắng US-3.6 và cảnh báo điểm US-5.4 chưa có. US-8.6 (`POST /exports`, nút "Xuất Excel / CSV" ở T12): P1, cần `files` và worker. Chuyên cần mỗi lớp vẫn có trong `revenue-by-class` (`attendancePercent`) cho thẻ "Theo lớp".
- US-8.3 (công nợ T11) đã vào Sprint 6; ô "Công nợ" của T12 lấy `summary.totalAmount` của `GET /receivables`.

Báo cáo (`reports`, chỉ `tenant_owner`, chỉ đọc):

- Số liệu đọc từ `revenue_ledger` nên "Đã thu" khớp từng đồng với danh sách thanh toán (US-8.1 AC2): `collectedAmount` = Σ dòng sổ có `entry_date` trong tháng, gồm dòng đảo; hủy thanh toán là sửa sai nên dòng đảo mang ngày thu của khoản gốc và trừ khỏi tháng của khoản đó (đúng như `revenue_ledger` của S6-BE-02, US-9.5 AC1), không làm tháng hủy giảm; cột và tổng của mọi tháng vì vậy không âm (đính chính khi cài đặt S7 reports, chỉ đổi mô tả). `billedAmount` = Σ `totalAmount` hóa đơn đã phát hành (không nháp, không hủy) của kỳ thu tháng đó. `outstandingAmount` và `activeStudentCount` là giá trị hiện tại, không theo tháng chọn.
- US-8.2 AC3 đòi tổng theo lớp bằng đúng "đã thu": hóa đơn gộp nhiều lớp nên **phải có quy tắc chia thanh toán cho lớp** (ghi ở `RevenueByClass`): theo tỷ lệ dòng học phí dương của từng lớp, làm tròn phần dư lớn nhất; phần không gán được là dòng "Khác" (`classId = null`). **Chờ TL xác nhận** (phương án khác: chỉ phân bổ theo hóa đơn phát hành, không theo thanh toán).
- `month` là `YYYY-MM`, mặc định tháng hiện tại theo múi giờ tenant, không phân trang cho theo lớp và 12 tháng; `payments` phân trang offset. Phần "cập nhật báo cáo" của US-7.4 AC3 không cần job: đọc thẳng sổ.

Gói và dùng thử (`subscription`, chỉ `tenant_owner`):

- `GET /plan-usage` gom một lần gọi cho T14: gói, `limits` (null = không giới hạn), `usage`, `readOnly` (số lớp/học sinh chỉ đọc sau hết dùng thử, US-0.8 AC4), `features` (feature flag, khóa mở: Spec §4.4), `pendingBankTransferOrder` cho T14a. `trialAvailable` quyết định biến thể "Đã dùng thử" của T14. Giá Pro VNĐ (`proPriceVnd`) null tới khi PO chốt; giá IAP lấy từ RevenueCat ở app.
- `POST /subscription/trial`: không body, `Idempotency-Key` bắt buộc, trả `PlanUsage`. Đã dùng thử → 422 `TRIAL_ALREADY_USED`; đang trialing/active → 409 `CONFLICT_STALE`. 14 ngày tính từ lúc gọi.
- `POST /subscription/bank-transfer-orders` (R6: chỉ client web, app không dẫn tới): đã có đơn `pending` thì trả lại đơn đó. Tài khoản nhận và giá do cấu hình hệ thống; `transferNote` theo quy tắc `[A-Z0-9 ]` ≤ 25. Kích hoạt Pro qua `POST /admin/bank-transfer-orders/{id}/confirm` có sẵn. **Chờ PO xác nhận R6** (Spec §10) vì T14a trong Figma spec vẫn vẽ lựa chọn "Chuyển khoản" trong app.
- Webhook RevenueCat: `app_user_id` = `tenant_id`; xác thực header `Authorization` bí mật, idempotent theo `event.id`; sự kiện hợp lệ nhưng không áp dụng (loại lạ, `TEST`, `SANDBOX` ở production, tenant lạ, kho khác App Store/Play, cũ hơn sự kiện đã xử lý) trả 200 `ignored` để RevenueCat không thử lại; chỉ sai bí mật (401) và thân sai (422) trả lỗi. Chưa có `@Public()` và guard bí mật: JwtAuthGuard toàn cục đang chặn 401, task backend thêm cả hai (cùng cách AdminGuard của Sprint 2).
- Nhắc gia hạn còn 7 và 1 ngày (US-0.8 AC5, job `subscription.lifecycle`) và push "Pro đã kích hoạt": cần thêm loại thông báo vào `Notification`; **chưa khai** vì cùng vướng `oasdiff` `response-property-one-of-added` như `schedule_changed`, `billing_ready`, `invoice_issued`, `payment_recorded` (chờ Owner/TL chọn một lần cho tất cả). Hiện app đọc từ `GET /plan-usage` (`plan.daysLeft`).

Chờ chốt:

- Quy tắc chia doanh thu theo lớp (trên), R6 chuyển khoản trong app, giá Pro VNĐ. Đã làm: ngoại lệ `oneOf` cho các loại thông báo mới (xem "Ngoại lệ một lần").

Đã chốt khi duyệt (S6-CT-01, điều phối theo ủy quyền của Owner 21/11/2026):

- Doanh thu theo lớp (`revenue-by-class`): chia số đã thu của hóa đơn gộp nhiều lớp theo tỷ lệ các dòng học phí dương, làm tròn theo phần dư lớn nhất; phần không gán được (nợ kỳ trước, điều chỉnh tay) vào dòng "Khác". Tổng các lớp + "Khác" = đúng "đã thu" (US-8.2 AC3).
- Chuyển khoản mua gói theo R6: chỉ trên web. App (T14) chỉ có IAP; không có nút/link dẫn ra thanh toán trên web (R6/D3, chống anti-steering của store); Figma T14a không phải nguồn nghiệp vụ.
- `proPriceVnd`: giữ null tới khi PO chốt giá (việc của Owner, không suy từ mockup).
- Các loại thông báo chưa vào `oneOf` của `Notification` (`schedule_changed`, `billing_ready`, `invoice_issued`, `payment_recorded`, `payment_reminder`, nhắc gia hạn, Pro đã kích hoạt) và giá trị `not_marked`: chấp nhận ngoại lệ `oasdiff` MỘT LẦN vì chưa có bản app nào phát hành ra ngoài; làm ở PR riêng trước khi nộp store, sau đó mọi thay đổi lại phải sạch `oasdiff`.

Triển khai backend `subscription` (Sprint 7; chỉ mô tả và một mã phản hồi 503 thêm vào, schema không đổi, `oasdiff breaking` sạch). Migration `0029_subscription`: bảng `plan_features`, `tenant_feature_overrides`, `subscription_events`, `bank_transfer_orders` (các bảng này chưa tồn tại từ Sprint 2, dòng "Không có bảng hay migration mới" ở trên không còn đúng), RLS + FORCE, hàm security definer `start_trial`, `rc_begin_event`, `rc_apply_event`. Quyết định:

- **Một nguồn sự thật về gói**: `PlanService` (module `subscription`, `PlanModule` không controller) đọc `subscriptions` + `plans.limits` + `plan_features`/`tenant_feature_overrides`; `plan-usage` và 402 `PLAN_LIMIT_EXCEEDED` ở `POST /classes`, `POST /students` dùng chung. Lớp đếm `status = active`, học sinh đếm `status = active` (tạm nghỉ/đã nghỉ không tính). Kiểm dưới advisory lock theo tenant nên hai request song song không cùng vượt giới hạn. `details` của 402: `limit`, `current`, `attempted`, `feature` (`max_active_classes`/`max_active_students`). Ghi danh không kiểm giới hạn (không tăng số học sinh đang học).
- **Hết hạn tính ngay khi đọc**: `trialing`/`active` có `currentPeriodEnd` ≤ bây giờ được coi là `expired` (plan `free`, giới hạn Free, `readOnly` = phần vượt) không đợi job `subscription.lifecycle`; job chỉ còn việc đồng bộ cột và nhắc gia hạn. `daysLeft` làm tròn lên theo khối 24 giờ.
- **Dùng thử**: nguyên tử trong `app_private.start_trial` (khóa dòng). Đang `trialing`/`active` còn hạn → 409 `CONFLICT_STALE`; đã từng dùng thử → 422 `TRIAL_ALREADY_USED`; `trialAvailable` = chưa từng dùng thử và đang Free.
- **Đơn chuyển khoản**: giá `PRO_PRICE_VND` và tài khoản nhận `PAYEE_BANK_BIN`/`PAYEE_ACCOUNT_NO`/`PAYEE_ACCOUNT_NAME`/`PAYEE_BANK_NAME` lấy từ env; thiếu → 503 `SERVICE_UNAVAILABLE` (không bịa đơn), `plan-usage.proPriceVnd` = null khi chưa đặt giá. Nội dung chuyển khoản `TH PRO xxxxxx` (6 ký tự ngẫu nhiên, duy nhất). Một đơn `pending` mỗi tenant (unique một phần). Bảng `bank_transfer_orders` do task admin (`POST /admin/bank-transfer-orders/{id}/confirm`, hiện còn 501) nối vào; xác nhận cần đặt `subscriptions` = Pro `active`, `source = bank_transfer`.
- **Webhook RevenueCat**: bí mật `REVENUECAT_WEBHOOK_SECRET` (`Authorization`, `timingSafeEqual` trên SHA-256), chưa cấu hình → 401 như sai bí mật. `app_user_id` = `tenant_id`; không phải UUID hoặc tenant không có → `ignored`. Idempotent theo `event.id` (unique `(source, event_id)`, khóa dòng subscription nên giao đồng thời vẫn một lần áp dụng). Allowlist `REVENUECAT_PRO_PRODUCT_IDS` (CSV): `product_id` thiếu/lạ, rỗng danh sách → `ignored` + log cảnh báo không PII. Chỉ `active` khi `expiration_at_ms` ở tương lai; `NON_RENEWING_PURCHASE` không có hạn dùng `REVENUECAT_NON_RENEWING_DAYS` (`product_id:ngày`), không cấu hình → `ignored`. Sự kiện có `event_timestamp_ms` nhỏ hơn sự kiện đã áp dụng của tenant → `ignored` (cả `EXPIRATION`). `EXPIRATION` chỉ hạ gói khi đang `active` bằng đúng kho đó. `CANCELLATION`/`BILLING_ISSUE` chỉ ghi sự kiện (kết quả `ignored`, gói giữ tới hết kỳ). `SANDBOX` bị bỏ qua khi `NODE_ENV=production`. `subscription_events.payload` chỉ giữ trường kỹ thuật (không PII).
- **Chưa làm (ngoài phạm vi task)**: job `subscription.lifecycle` (đánh dấu `is_readonly` cho lớp/học sinh vượt giới hạn, nhắc gia hạn 7 và 1 ngày), `FeatureGuard` cho các route Pro (`FEATURE_REQUIRES_PRO`), nối xác nhận chuyển khoản phía admin.

Gia cố webhook sau review bảo mật (migration `0030_subscription_webhook_hardening`; schema chỉ thêm trường tùy chọn `original_transaction_id`, `oasdiff breaking` sạch):

- `app_private.rc_begin_event`/`rc_apply_event` chỉ chạy khi giao dịch có cờ `app.webhook = '1'` (do `RevenueCatService` đặt bằng `set_config(..., true)`), gọi từ role app không có cờ → lỗi 42501. Giới hạn: cờ do chính role app đặt nên chặn gọi nhầm, không thay cho chống SQL injection. Đổi `subscriptions` qua hàm security definer vẫn ghi `audit_logs` nhờ trigger audit (actor trống vì webhook không có user).
- Sự kiện đã `ignored` (product/store/cấu hình/trạng thái) được xử lý lại khi RevenueCat gửi lại cùng `event.id`; chỉ `processed` mới là `duplicate` (id thuộc tenant khác cũng trả `duplicate`).
- Kích hoạt từ store không rút ngắn hay ghi đè kỳ đang trả bằng nguồn khác: bỏ qua (`would_shorten`) khi kỳ hiện tại còn hạn, có nguồn khác kho này và hạn mới ≤ hạn hiện tại; cùng kho, nguồn null (dùng thử) hoặc kỳ đã hết hạn thì áp dụng bình thường.
- `external_ref` lưu `product_id` (kèm `#original_transaction_id` nếu có) khi kích hoạt; `EXPIRATION` chỉ hạ gói khi `product_id` và `original_transaction_id` (nếu có trong sự kiện) khớp kỳ đang lưu.
- Thời gian: `event_timestamp_ms` bắt buộc cho sự kiện kích hoạt và `EXPIRATION` (thiếu → `ignored`), mốc quá 1 giờ trong tương lai → `ignored` (tránh đầu độc thứ tự), hạn > 400 ngày → `ignored`. `expiration_at_ms`/`event_timestamp_ms` ngoài [0, 01/01/2100] → 422 `VALIDATION_FAILED` kiểm trong service, không đặt `minimum`/`maximum` vào schema vì oasdiff coi là breaking (`request-property-max-decreased`).
- Log cảnh báo không PII cho mọi lý do bỏ qua bất thường, gồm tenant lạ (`unknown_tenant`).


Hoàn thiện vòng đời gói (Sprint 7, phần còn lại sau #194; không đổi `openapi.json`, `oasdiff breaking` sạch; không migration cho phần job và guard). Quyết định:

- **`FeatureGuard` / `@RequiresFeature('<code>')`** (module `subscription`, export từ index): tenant không có cờ → 402 `FEATURE_REQUIRES_PRO`, `details.feature`. Cờ = `plan_features` của gói hiệu lực (Pro hết hạn về cờ Free ngay) rồi `tenant_feature_overrides` ghi đè; khóa không có dòng nào coi là tắt. Phải đứng sau `@RequiresRole` (cần `ctx.tenantId`), thiếu tenant → 403. Spec chỉ gắn Pro cho `compliance.form02/form03`, sổ doanh thu, xuất báo cáo (US-0.7 AC3, US-9.2/9.4/9.5/8.6): các route này CHƯA có trong code lẫn hợp đồng, nên chưa áp vào route nào; task làm route đó chỉ việc import `PlanModule` và thêm decorator (decorator tự khai 402 vào hợp đồng).
- **Job `subscription.lifecycle`** (06:00 giờ VN, tự ghi `job_runs`, worker): (1) `trialing`/`active` quá `current_period_end` → `plan_code = free`, `status = expired` bằng một UPDATE có điều kiện (không đè kỳ vừa gia hạn); giữ nguyên `source`, `current_period_end`. (2) Nhắc gia hạn còn ≤ 7 ngày (mốc 7) và ≤ 1 ngày (mốc 1): chỉ MỘT mốc sát nhất mỗi lần, nên chạy muộn không dồn hai nhắc. Chống trùng bằng dòng `subscription_events` (`source = lifecycle`, `event_id = reminder:<tenant>:<hạn epoch ms>:<mốc>`, duy nhất theo `(source, event_id)`) ghi cùng giao dịch với sự kiện outbox `subscription_expiring` (payload `{ offsetDays, currentPeriodEnd }`, không PII); gia hạn đổi hạn thì kỳ mới được nhắc lại.
- **Thông báo** (consumer `SubscriptionNotifier`, theo mẫu `billing_ready`): loại `subscription_expiring` (payload `{ offsetDays: 7|1, currentPeriodEnd }`) và `subscription_activated` (payload `{ source: 'bank_transfer', currentPeriodEnd }`) tạo thông báo cho chủ tenant + push chữ khay chung (không số, không ngày). `subscription_expiring` được kiểm lại lúc xử lý (kỳ đã gia hạn/không còn trả phí thì bỏ). Hai loại này CHƯA vào `oneOf` của `Notification` (ngoại lệ `oasdiff` chung đã chốt, làm ở PR riêng trước khi nộp store, cùng nhóm `payment_reminder`...); app đọc `GET /plan-usage`. `is_readonly` của lớp/học sinh vượt giới hạn không cần cột: `readOnly` tính từ số đếm theo thời điểm tạo (đã có ở `plan-usage`), nên job không đánh dấu từng bản ghi.

Admin xác nhận chuyển khoản (Sprint 7; `openapi.json` chỉ đổi mô tả của `POST /admin/bank-transfer-orders/{id}/confirm`, `oasdiff breaking` sạch; migration `0031_subscription_admin_confirm`). `GET /admin/bank-transfer-orders` và `confirm` có thân hàm thật; bài quy định và tra cứu hỗ trợ còn 501 (sau guard). Quyết định:

- **`AdminGuard`** (Spec §5.2e, thay JWT trên cả `AdminController`): `x-admin-secret` so với `ADMIN_API_SECRET` (env mới, ≥ 16 ký tự, so thời gian hằng; chưa cấu hình → 401) và `x-admin-user-id` không rỗng (≤ 128 ký tự) → 401 `UNAUTHENTICATED`; `x-admin-permissions` khác đúng URI quyền của route (`/teachhub/admin/bank-transfer`...) hoặc route không khai quyền → 403 `FORBIDDEN`. Token người dùng không thay được secret admin (401).
- **Ghi qua hàm security definer** `app_private.admin_list_bank_transfer_orders` và `admin_confirm_bank_transfer`: chỉ chạy trong giao dịch có cờ `app.admin = '1'` và `app.admin_user` (do `BankTransferAdminService` đặt sau guard), gọi từ role app không cờ → 42501; thu quyền với worker/readonly. Giới hạn như `app.webhook`: cờ do role app tự đặt nên chặn gọi nhầm, không thay cho chống SQL injection. Thêm policy INSERT `outbox_events` cho `teachhub_owner` để hàm ghi sự kiện push.
- **Xác nhận**: khóa đơn rồi subscription (một giao dịch). Đơn `pending` → `confirmed` (`confirmed_by` = `x-admin-user-id`, `bank_transaction_ref`, `confirmed_at`); `subscriptions` → `pro`/`active`, `source = bank_transfer`, `external_ref = bank_transfer:<orderId>`; outbox `subscription_activated` (push cho chủ tenant). **Kỳ 12 tháng** (Spec không nêu thời lượng; giá Pro cấu hình là giá một năm, US-0.8 AC2 "10 USD/năm"). Đang `active`/`trialing` còn hạn: cộng nối từ hạn hiện tại (không rút ngắn); hết hạn/Free: tính từ lúc xác nhận. Nếu kỳ đang là của store (App Store/Play) thì `source` đổi thành `bank_transfer` (hạn dài hơn), sự kiện `EXPIRATION` của store sau đó không hạ gói (đúng quy tắc `not_current_source`); chấp nhận vì hiếm, không có chống mua trùng hai kênh (việc của PO).
- **`amount` phải bằng số tiền của đơn** (thiếu/thừa → 422 `VALIDATION_FAILED` ở `amount`, không kích hoạt): admin đối chiếu sao kê, không tự chốt đơn thiếu tiền. `expectedUpdatedAt` so ở độ chính xác mili giây; lệch → 409 `CONFLICT_STALE`.
- **Idempotent**: gọi lại `confirm` với cùng `bankTransactionRef`, `amount` và cùng `x-admin-user-id` → 200 với kết quả cũ (không cộng kỳ lần hai, không thêm sự kiện push); khác đi, hoặc admin khác → 409 `CONFLICT_STALE` (đơn không còn `pending`). `Idempotency-Key` bắt buộc đúng dạng UUID nhưng không lưu bảng `idempotency_keys` (admin không có user); an toàn nhờ trạng thái đơn.
- **Audit**: trigger audit của `bank_transfer_orders` và `subscriptions` ghi `audit_logs` (actor trống vì không có user app; người xác nhận nằm trong `after_data.confirmed_by`).
- **Từ chối/hủy đơn**: hợp đồng chỉ có `pending`/`confirmed` và không có endpoint từ chối, nên chưa làm; thêm khi hợp đồng bổ sung.

Gia cố admin sau review bảo mật (migration `0032_bank_transfer_ref_unique`; `openapi.json` chỉ đổi mô tả và thêm phản hồi 409/429 + hai mã lỗi mới trong `error_codes.json`, `oasdiff breaking` sạch):

- **Giới hạn**: cả nhóm `/v1/admin/**` 30 request/phút/IP (`@Throttle`, trên mặc định 300), vượt → 429 `RATE_LIMITED`. **Khuyến nghị hạ tầng (làm sau)**: chặn `/v1/admin/*` bằng allowlist IP của BFF ở Cloudflare.
- **Xoay secret**: env tùy chọn `ADMIN_API_SECRET_PREVIOUS` cũng được chấp nhận (so thời gian hằng cả hai secret). Quy trình: đặt secret mới ở `ADMIN_API_SECRET`, secret cũ sang `..._PREVIOUS`, đổi BFF, rồi gỡ `..._PREVIOUS`.
- **`x-admin-user-id` phải là UUID** (không phải → 401). Audit: ngoài `confirmed_by` trong `after_data` của `bank_transfer_orders` (đã kiểm bằng e2e), hàm confirm ghi thêm một dòng `audit_logs` `entity = bank_transfer_order_confirm` có `confirmed_by`, `request_id`, `ip` (IP sau `trustProxy`), `bank_transaction_ref`, `amount`.
- **Mã giao dịch duy nhất**: unique một phần `bank_transfer_orders(bank_transaction_ref) where not null`; mã đã dùng cho đơn khác → 409 `BANK_TRANSACTION_REF_USED` (kể cả khi hai đơn đua nhau: bắt `unique_violation`, đơn vẫn `pending`).
- **Không chồng lên kỳ của store**: tenant đang `active` từ `app_store`/`play_store` còn hạn → 409 `SUBSCRIPTION_STORE_MANAGED` (không cộng nối, không đổi `source`, không outbox). Dùng thử, chuyển khoản, hoặc kỳ store đã hết hạn thì xác nhận như cũ (cộng nối nếu còn hạn). Thay quyết định trước đó "đổi `source` thành `bank_transfer`" cho kỳ store.

## Sprint 8 "Tuân thủ, tệp và báo tin chuyển khoản" (S7-CT-01)

Thân hàm trả 501 `NOT_IMPLEMENTED` tới khi làm task backend tương ứng; schema đã validate thật. 23 endpoint mới, `oasdiff breaking` sạch. Soạn theo ủy quyền của Owner (tự quyết phạm vi theo Spec §11.1, User Stories, PRD, phần "Để Sprint 8" của Sprint 7); các quyết định ghi bên dưới.

| Endpoint | Story | Ưu tiên | Pro (402 `FEATURE_REQUIRES_PRO`) |
| --- | --- | --- | --- |
| `GET /v1/compliance/checklist`, `PATCH /v1/compliance/checklist/{itemKey}` | US-9.1 | P0 | không |
| `GET /v1/compliance/form02` | US-9.2 AC1, AC4 | P0 | không (xem trước, `featureEnabled`) |
| `POST /v1/compliance/form02/publish` | US-9.2 AC2, AC3 | P0 | có, `compliance.form02` |
| `GET /v1/public/disclosures/{slug}` (công khai, không JWT) | US-9.2 AC2 | P0 | không |
| `GET /v1/compliance/school-declaration`, `PUT /v1/compliance/school-declaration` (GET bổ sung ngoài Spec) | US-9.4 AC1, AC3 | P0 | không |
| `GET /v1/compliance/form03` (bổ sung ngoài Spec) | US-9.4 AC2, AC3 | P0 | không (xem trước, `featureEnabled`) |
| `POST /v1/compliance/form03/pdf` | US-9.4 AC2 | P0 | có, `compliance.form03` |
| `GET /v1/compliance/revenue-book` | US-9.5 AC1 đến AC4 | P0 | không |
| `POST /v1/compliance/revenue-book/export` | US-9.5 AC4 | P0 | có, `revenue.export` |
| `POST /v1/compliance/tax-alerts/{id}/dismiss` (bổ sung ngoài Spec) | US-9.5 AC3 | P0 | không |
| `GET /v1/legal-articles`, `GET /v1/legal-articles/{slug}` | US-9.6 AC1, AC3 | P0 | không |
| `POST /v1/classes/{id}/warning-acknowledgements` (bổ sung ngoài Spec) | US-9.3 AC3 | P0 | không |
| `POST /v1/files/upload-urls`, `POST /v1/files/{id}/complete`, `GET /v1/files/{id}/download-url` | US-7.7 (nền cho US-4.1, 4.2, 6.3) | P1 | không |
| `POST /v1/family/invoices/{id}/payment-claims`, `POST /v1/payment-claims/{id}/resolve`, `GET /v1/invoices/{id}/payment-claims` (GET bổ sung ngoài Spec) | US-7.7 | P1 | không |
| `POST /v1/exports`, `GET /v1/exports/{id}` | US-8.6 | P1 | `POST` có, `reports.export` |

Mã lỗi mới: `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED` (422, Spec §5.6). Không có endpoint nào sửa response/request đã phát hành.

Quyết định phạm vi:

- **Vào Sprint 8**: toàn bộ E9 (US-9.1 đến 9.6, đều P0) để T13 chạy trọn; `files` + US-7.7 (Sprint 7 đã hẹn); US-8.6 vì sổ doanh thu cần worker xuất tệp và `files`, dùng chung một "việc xuất" (`ExportJob`) cho `POST /exports`, `POST /compliance/revenue-book/export` và `POST /compliance/form03/pdf`, hỏi trạng thái bằng `GET /exports/{id}`.
- **Dời sang Sprint 9** (cùng lý do: một sprint không chứa nổi thêm hai miền lớn và mini-app học sinh S01):
  - `assignments` (US-4.1, 4.2, 4.3 P0; US-4.4 P1) và `grades` (US-5.1, 5.2 P0; US-5.3, 5.4 P1): khoảng 12 endpoint, kèm mini-app student S01, phụ thuộc `files` (làm trước ở Sprint 8) và vai trò `student`; thêm `purpose` `assignment` và `submission` vào `FilePurpose` (thêm giá trị vào request không phá hợp đồng).
  - Nhập học viên Excel/CSV (US-1.5 P0, `/imports/students*`): cần `files` (`purpose = import`) + worker kiểm từng dòng; làm cùng cảnh báo trùng trường chính khóa theo dòng (US-9.4 AC1), vì cảnh báo khi `POST /students` cần đổi 409 của endpoint đó (hiện đã dùng cho `STUDENT_POSSIBLE_DUPLICATE`, phải thêm `oneOf`) nên gộp một lần.
  - Bản tin tuần/tháng (US-6.4 P1), tin nhắn chung cả lớp (US-6.3 P1), chuyên cần (US-8.4), danh sách nguy cơ nghỉ (US-8.5): P1, phụ thuộc cảnh báo vắng US-3.6, cảnh báo điểm US-5.4 và `grades` chưa có.
- **Loại thông báo mới** (`payment_claim_created`, `payment_claim_rejected`, `tax_threshold_alert`, bài quy định đổi US-9.6 AC2): chưa khai vào `oneOf` của `Notification`, cùng nhóm ngoại lệ `oasdiff` đã chốt ở Sprint 7 ("làm ở PR riêng trước khi nộp store"). Trong lúc chờ app đọc trạng thái trực tiếp: `alerts` của `GET /compliance/revenue-book`, `status` của `PaymentClaim`.

Quyết định thiết kế:

- **Pro theo thao tác, không theo màn**: xem trước Mẫu 02 và Mẫu 03 mở cho mọi gói (có `featureEnabled`) để client làm mờ và mời nâng cấp (US-9.2 AC4); công khai, PDF Mẫu 03, xuất sổ doanh thu, xuất báo cáo là Pro. `@RequiresFeature` đặt trên đúng bốn route: `POST /compliance/form02/publish` (`compliance.form02`), `POST /compliance/form03/pdf` (`compliance.form03`), `POST /compliance/revenue-book/export` (`revenue.export`), `POST /exports` (`reports.export`). `GET /exports/{id}` không kiểm gói. Checklist, khai trường, sổ doanh thu và ngưỡng thuế, thư viện quy định: mọi gói (US-9.1 AC4, US-9.5 AC4).
- **Cảnh báo ngưỡng thuế** (US-9.5 AC3): mốc `400m` và `800m`, một cảnh báo cho mỗi (tenant, năm, mốc) (`tax_threshold_alerts` unique); sinh khi ghi thanh toán làm lũy kế vượt mốc, không sinh lại khi hủy rồi thu lại. `taxAlerts` ở phản hồi `POST /invoices/{id}/payments` (ví dụ Spec §5.4) KHÔNG thêm vào `PaymentResult`; app đọc `alerts` của `revenue-book`. Nghĩa vụ ở mỗi ngưỡng do bài thư viện giải thích (`legalArticleSlug`), nội dung kế toán duyệt; hợp đồng không ghi số liệu thuế.
- **`slug` công khai Mẫu 02** sinh một lần, cố định kể cả khi tắt/bật lại (US-9.2 AC2). Trang công khai chỉ có thông tin Mẫu 02, không có dữ liệu học viên/phụ huynh, slug lạ hoặc đã tắt đều 404 như nhau. Chưa có lớp hoặc còn trường thiếu thì không công khai được (422).
- **Mẫu 03**: cột chính xác của biểu mẫu do PDF quy định **[Cần luật sư chốt mẫu]**; hợp đồng chỉ chốt dữ liệu điền sẵn (học viên có trường + lớp chính khóa trùng khai báo, so khớp không dấu, không phân biệt hoa thường).
- **US-9.3** cảnh báo lớp tiểu học vẫn không chặn như hợp đồng Sprint 3 (`ClassCreated.warnings`); chỉ thêm bước ghi xác nhận (`POST /classes/{id}/warning-acknowledgements`, bảng `acknowledgements`) thay vì `409 WARNING_ACK_REQUIRED` của Spec, để khỏi đổi hành vi `POST /classes` đã phát hành. Mã cảnh báo: `TT29_PRIMARY_ACADEMIC`.
- **`files`**: tệp không đi qua API, URL PUT/GET 10 phút, MIME và trần kích thước theo `purpose` (`receipt`: ảnh JPEG/PNG/HEIC ≤ 10 MB). Sprint 8 chỉ có `purpose = receipt`. Tenant của tệp lấy từ thực thể (hóa đơn), không từ vai trò đang mở của người gọi. Quyền xem biên lai: phụ huynh đã tải lên và giáo viên của tenant sở hữu hóa đơn; còn lại 404.
- **`payment_claims`**: một lần báo `pending` mỗi hóa đơn (báo thêm → 409 `CONFLICT_STALE`); hóa đơn sang `pending_confirmation` (đã có sẵn trong enum), hủy nhắc nợ chưa gửi (lập lại khi từ chối, US-7.7 AC1, AC3). `confirm` xử lý đúng như `POST /invoices/{id}/payments` với `bank_transfer` và trả `PaymentResult`. Số tiền phụ huynh khai chỉ để đối chiếu, giáo viên quyết số ghi thu.
- **`ExportJob`**: bất đồng bộ (`202`), hỏi lại `GET /exports/{id}`; tệp lên bucket private, link tải theo Spec §2.7 (72 giờ, giữ 7 ngày). CSV UTF-8 BOM, tiền là số, ngày dd/mm/yyyy (US-8.6 AC2).

Điểm còn mở:

- **Bảng mới cho task backend** (chưa có migration): `files`, `payment_claims` (Spec §4.4); `compliance_items`, `school_declarations`, `public_disclosures`, `tax_threshold_alerts`, `acknowledgements`, `exports`, và `legal_articles` (Spec §4.4; `/admin/legal-articles` còn 501 nên bảng chưa có, task `compliance` làm cùng task admin). `revenue_ledger.fiscal_year` đã có từ Sprint 6 (migration 0026). Migration nằm ngoài task hợp đồng.
- Nội dung tiêu đề/mô tả bốn mục checklist và các bài thư viện quy định do admin soạn và duyệt (US-9.6 AC3): `legalArticleSlug` null cho tới khi có bài phát hành.
- Cần chốt với luật sư: Mẫu 02/03 theo Thông tư 29 (trường bắt buộc, thời hạn công khai) và nghĩa vụ ứng với ngưỡng 500 triệu và 1 tỷ.
- Worker: job sinh PDF Mẫu 02 (bucket `public`), job xuất tệp, job dọn tệp `pending` quá 24 giờ (Spec §3.6c) thuộc task backend/worker, chưa có trong hợp đồng này vì không có API.

Triển khai backend `files` và `payment_claims` (Sprint 8, S8-BE-files-claims; `openapi.json` chỉ đổi mô tả của `POST /files/upload-urls`, `POST /files/{id}/complete`, `receiptFileId` và `disabledReason` của nhắc nợ; `oasdiff breaking` sạch so với `s8-contract`). Migration `0036_files_payment_claims`: bảng `files`, `payment_claims` (RLS + FORCE), mở thêm lý do hủy nhắc nợ `claim_pending`. Quyết định:

- **`files`**: bucket private duy nhất; khóa `{tenant_id}/receipts/{hóa đơn}/{UUID v4}.{jpg|png|heic}` (UUID v4 ngẫu nhiên, không dùng v7 vì chứa giờ; tên gốc chỉ ở cột `original_name`). `tenant_id` lấy từ hóa đơn. Loại ảnh `receipt`: chỉ `image/jpeg`, `image/png`, `image/heic` (đúng mô tả `FilePurpose` của hợp đồng, **không có PDF**: Spec §3.3 không liệt kê định dạng riêng cho `receipts/`; thêm `application/pdf` là thêm một dòng ở `PURPOSE_POLICY` nếu PO muốn), trần 10 MB (kiểm ở API trước khi cấp URL, và `files_size_check` ≤ 20 MB ở CSDL). Thứ tự kiểm khi xin URL: quyền thực thể (404) → đồng ý điều khoản (403) → MIME (422) → kích thước (422).
- **URL ký cả `Content-Type` và `Content-Length`** (SigV4, hạn 10 phút): client gửi khác loại hoặc khác số byte đã khai bị kho S3 từ chối (403 từ kho, không qua API), nên URL không dùng để đẩy tệp lớn hơn khai báo. `S3Client` đặt `requestChecksumCalculation = WHEN_REQUIRED` vì checksum mặc định của SDK mới (`x-amz-checksum-crc32` của thân rỗng) làm hỏng presigned PUT trên R2/MinIO. Thêm dependency `@aws-sdk/s3-request-presigner` (cùng phiên bản `client-s3`).
- **`complete`** HEAD kho S3 (không giữ giao dịch DB): chưa có đối tượng → 409 `CONFLICT_STALE`; nhiều byte hơn khai báo hoặc quá trần → 422 `FILE_TOO_LARGE`; content-type lệch → 422 `FILE_TYPE_NOT_ALLOWED`; ít byte hơn khai báo → 422 `VALIDATION_FAILED` ở `sizeBytes` (hợp đồng không có mã riêng); cả ba xóa đối tượng, dòng `files` vẫn `pending` (client xin URL mới, job dọn xóa sau 24 giờ). Chỉ người xin URL gọi được (kể cả giáo viên cũng 404); gọi lại trên tệp `ready` 200.
- **Quyền** do RLS (`files_uploader_read`, `files_staff_read`, `files_receipt_insert`, `files_uploader_update`): `receipt` do phụ huynh đã liên kết với con còn học tạo (cùng điều kiện `GET /family/invoices/{id}`, kể cả hóa đơn đã hủy; việc chặn báo cho hóa đơn không thu được nằm ở `payment-claims`); xem lại: chính người tải lên hoặc nhân sự tenant sở hữu hóa đơn (ở API chỉ `tenant_owner` qua controller). Phụ huynh khác, tenant khác, tệp `pending` → 404. Quyền xem theo người tải lên, không theo liên kết hiện tại. Không có lộ khóa đối tượng qua `FileRecord`; URL chỉ sống 10 phút (không có URL lâu dài). Trigger `files_guard` chỉ cho `pending → ready`; role app/readonly không xóa được `files`.
- **Job `files.purge-pending`** (worker, 04:00 giờ VN, ghi `job_runs`): xóa đối tượng rồi dòng của tệp `pending` quá 24 giờ, theo lô 200, lọc `status = 'pending'` tường minh; xóa đối tượng lỗi thì giữ dòng, lần sau thử lại.
- **`payment_claims`**: tạo qua hàm `app_private.create_payment_claim` (security definer, chạy bằng `teachhub_owner` nên thêm policy owner cho `invoices`, `dunning_jobs`, `files`, `payment_claims`) vì phụ huynh không có quyền đổi hóa đơn/nhắc nợ. Hàm khóa hóa đơn rồi kiểm: người giám hộ còn hiệu lực của con còn học, hóa đơn không nháp (404); `void`/`paid`/hết nợ → `INVOICE_NOT_PAYABLE`; đã có lần báo `pending` hoặc hóa đơn `pending_confirmation` → `CONFLICT_STALE` (kể cả hai request song song: unique một phần `payment_claims_pending_uq`); biên lai phải `ready`, của chính người gọi, `entityId` = hóa đơn, chưa dùng (unique `payment_claims_receipt_uq`: bị từ chối thì tải biên lai mới), sai → 422 `VALIDATION_FAILED` ở `receiptFileId`. Cùng giao dịch: ghi lần báo, hóa đơn `pending_confirmation`, hủy mốc nhắc nợ chưa gửi với lý do `claim_pending` (không dùng `settled` để lập lại đúng mốc khi bị từ chối), outbox `payment_claim_created`, audit hóa đơn (lần báo có trigger audit `trg_payment_claims_audit`, actor là phụ huynh).
- **`resolve`** khóa hóa đơn rồi lần báo (cùng thứ tự với hàm tạo, không vòng chờ). `confirm` gọi `PaymentsService.record` (cùng giao dịch và `Idempotency-Key` của request): đúng MỘT `payments` (`bank_transfer`, số tiền giáo viên quyết, mặc định số khai) + `revenue_ledger` + `student_ledger` + outbox `payment_recorded`; `billing.reconcile` vẫn 0 lệch (có e2e); sau đó `DunningService.reconcile(..., ['claim_pending'])` lập lại nhắc nợ nếu còn nợ (thu một phần). `reject` ghi `rejectReason`, trả hóa đơn về `issued`/`partially_paid` theo Σ thanh toán và lập lại nhắc nợ, outbox `payment_claim_rejected`. Lần báo không còn `pending` hoặc hóa đơn `void` → 409 `CONFLICT_STALE`. Giáo viên ghi thu trực tiếp trong lúc chờ: hóa đơn đã rời `pending_confirmation` nên `reject` giữ trạng thái đó, còn `confirm` trên hóa đơn đã thu đủ trả 409 `INVOICE_NOT_PAYABLE` (lần báo vẫn `pending`, giáo viên bấm `reject`). Lần báo đã xử lý bất biến (trigger `payment_claims_guard`, kể cả role worker). Hóa đơn `pending_confirmation` không hủy được (trigger `invoices_guard` chỉ cho `issued → void`): giáo viên xử lý lần báo trước.
- **Thông báo**: consumer `PaymentClaimNotifier` (theo mẫu `SubscriptionNotifier`): `payment_claim_created` → chủ tenant (chỉ khi lần báo còn `pending` lúc xử lý), `payment_claim_rejected` → phụ huynh đã báo (không phải mọi người giám hộ của con; chỉ khi còn `rejected`). Payload hộp thư: `{ claimId, invoiceId }`, `rejected` thêm `reason` (hợp đồng: lý do gửi kèm thông báo; đã đăng nhập mới thấy). Push dùng chữ khay chung mới ở `push-copy.ts` (không PII, không chữ số). Hai loại vẫn chưa vào `oneOf` của `Notification` (ngoại lệ `oasdiff` chung), app đọc `status` của `PaymentClaim` / `GET /invoices/{id}/payment-claims`.
- **Giới hạn đã biết**: (1) `GET /invoices/{id}/dunning` trả `disabledReason = 'paid'` cho hóa đơn `pending_confirmation` vì enum hợp đồng không có giá trị riêng (đã ghi vào mô tả; thêm giá trị enum phải qua ngoại lệ `oasdiff`). (2) Phụ huynh chưa có endpoint đọc lần báo của mình (hợp đồng chỉ có `GET /invoices/{id}/payment-claims` cho `tenant_owner`); phụ huynh biết kết quả qua thông báo `payment_claim_rejected` và trạng thái hóa đơn ở `GET /family/invoices/{id}`. (3) Hóa đơn `pending_confirmation` hiện cho phụ huynh `status` này ở `/family/invoices`, đúng enum đã phát hành.

Gia cố `files` và `payment_claims` sau review bảo mật (migration `0037_files_etag_audit_exclude`; `openapi.json` chỉ đổi mô tả, `oasdiff breaking` sạch):

- **URL PUT sống 2 phút** (URL GET vẫn 10 phút). `complete` lưu `etag` (bất biến sau `ready`) và đọc 32 byte đầu (GET Range): chữ ký không khớp MIME khai (JPEG/PNG/HEIC) → 422 `FILE_TYPE_NOT_ALLOWED` và xóa đối tượng. Tạo claim HEAD lại, ETag hoặc kích thước lệch lúc `complete` (tệp bị ghi đè hay biến mất) → 422 `VALIDATION_FAILED` ở `receiptFileId`. Giới hạn: giữa HEAD này và giao dịch tạo claim vẫn còn một khe hẹp (không khóa kho S3).
- **Tối đa 5 tệp `pending` mỗi (người tải, hóa đơn)** (khóa tư vấn chống đua), vượt → 429 `RATE_LIMITED` (mã sẵn có). `complete` từ chối tệp `pending` quá 24 giờ → 409 `CONFLICT_STALE`.
- **Audit `payment_claims`** không còn `note`, `reject_reason`, `claimed_by_name`, `resolved_by_name`: `app_private.audit_trigger` nhận danh sách cột loại trừ qua tham số trigger (ngoài `phone`/`email`). Dòng audit đã ghi trước migration (môi trường dev) không bị xóa.
- **Giới hạn đã biết, chưa sửa**: (1) giáo viên ghi thu trực tiếp trong lúc có lần báo `pending`: lần báo vẫn treo `pending` cho tới khi giáo viên `reject` (hoặc `confirm` bị 409 nếu đã thu đủ). (2) `files_staff_read` cho mọi nhân sự của tenant đọc metadata `files`; ở API chỉ `tenant_owner` qua controller, thu hẹp policy khi có vai trò nhân sự dùng tệp.
- **Kết chuyển bỏ qua hóa đơn `pending_confirmation`** (chỉ đổi hành vi server): xem trước nháp, job chốt kỳ và `POST /billing-periods/{id}/issue` chỉ kết chuyển nợ của hóa đơn `issued`/`partially_paid`. Trước đây kỳ sau phát hành trong lúc lần báo còn chờ thì nợ kỳ trước bị chuyển sang kỳ sau, `confirm` trả 409 `INVOICE_NOT_PAYABLE` và phụ huynh có thể bị đòi lại ở kỳ sau. Bị `reject` thì hóa đơn về `issued`/`partially_paid` và được kết chuyển ở lần phát hành kế tiếp.

### Sprint 8, backend `compliance` (E9): thân hàm đã làm, chỉ đổi mô tả (oasdiff `breaking` sạch)

Đã có thân hàm: `GET /compliance/checklist`, `PATCH /compliance/checklist/{itemKey}`, `GET /compliance/revenue-book`, `POST /compliance/tax-alerts/{id}/dismiss`, `GET /legal-articles`, `GET /legal-articles/{slug}`, `POST /classes/{id}/warning-acknowledgements`. Schema không đổi; chỉ mô tả của `GET /compliance/revenue-book` (cách và lúc sinh cảnh báo, có push) và `POST /classes` (`warnings` giờ có giá trị).

Vẫn trả 501 `NOT_IMPLEMENTED` (chờ luật sư/kế toán chốt cột Mẫu 02/03 và nghĩa vụ ứng với ngưỡng; xuất tệp làm cùng `exports` sau): `GET /compliance/form02`, `POST /compliance/form02/publish`, `GET /public/disclosures/{slug}`, `GET`/`PUT /compliance/school-declaration`, `GET /compliance/form03`, `POST /compliance/form03/pdf`, `POST /compliance/revenue-book/export`, `/exports`. Chưa có bảng `school_declarations`, `public_disclosures`.

Quyết định triển khai:

- **Cảnh báo ngưỡng thuế tính ngoài luồng ghi thanh toán** (không làm chậm/khóa nó): job `compliance.tax-threshold` 08:00 giờ VN hằng ngày + kiểm ngay khi chủ tenant mở `GET /compliance/revenue-book`. Mốc chạm khi Σ `revenue_ledger` của `fiscal_year` ≥ `warnAmount` (đúng 400.000.000 / 800.000.000 là chạm; 399.999.999 chưa). `paymentId`/`cumulativeAmount` = thanh toán đưa lũy kế (theo thứ tự ghi sổ `created_at, id`) chạm mốc lần đầu. Idempotent: unique `(tenant, năm, mốc)` + `ON CONFLICT DO NOTHING`, chỉ lần chèn thành công mới ghi outbox. Hủy thanh toán làm lũy kế tụt dưới mốc rồi thu lại không sinh cảnh báo mới; cảnh báo không xóa. Hệ quả: nếu chủ tenant không mở sổ, cảnh báo/push có thể trễ tới một ngày so với lúc ghi thanh toán; thu sau job cuối ngày 31/12 mà không mở sổ thì không được push (vẫn hiện khi mở sổ năm đó).
- **Outbox `tax_threshold_alert` + push chữ chung** (`{ alertId, fiscalYear, milestone }`, không số tiền, không PII) tới chủ tenant. Consumer tạo dòng `notifications` loại `tax_threshold_alert` (payload `{ fiscalYear, milestone }`), bỏ qua nếu cảnh báo đã đóng. Loại này CHƯA vào `oneOf` của `Notification` (đúng thỏa thuận Sprint 8: PR riêng trước khi nộp store), nên `GET /notifications` sẽ trả một loại ngoài `oneOf` cho tới đó: client phải bỏ qua loại lạ; app đọc `alerts` của `revenue-book`.
- **Không khuyến nghị pháp lý**: `legalArticleSlug` chỉ trả khi có bài đã phát hành với slug quy ước; ánh xạ cố định, admin đặt đúng slug khi soạn: `dang-ky-ho-kinh-doanh` (mục `business_registration`, `registration_number`), `cong-khai-mau-02`, `khai-bao-truong-chinh-khoa`, `nguong-doanh-thu-500-trieu` (cảnh báo `400m`), `nguong-doanh-thu-1-ty` (`800m`). Tiêu đề/mô tả bốn mục checklist do server cấp, chỉ mô tả việc cần làm.
- **Checklist**: mỗi (tenant, mục) một dòng `compliance_items`, chưa có dòng = `todo`. `PATCH`: mục `auto` → 422 ở `itemKey`; `registration_number` `done` bắt buộc `data.registrationNo`, mục khác không nhận `data`; chuyển `todo` xóa `data`; gọi lại cùng nội dung giữ nguyên `completedAt`. `public_disclosure` và `school_declaration` sẽ được ghi khi Mẫu 02 và khai báo trường có thân hàm (hiện luôn `todo`). `compliance_item_completed` ghi log có cấu trúc khi mục chuyển sang `done` (như onboarding, chưa có kênh analytics).
- **Sổ doanh thu**: `year` mặc định năm hiện tại theo múi giờ tenant (`fiscal_year` của sổ), `year` ngoài 2020–2100 → 422; `entries.totalAmount` = `cumulativeAmount`; hủy thanh toán là dòng đảo mang ngày khoản gốc nên hủy khoản năm trước không làm năm nay giảm.
- **Thư viện quy định**: bảng `legal_articles` (toàn hệ thống, cột như `LegalArticle` của admin). App chỉ đọc bài `published` có người duyệt (RLS + CHECK `legal_articles_published_check`); chưa có thân hàm admin nên danh sách rỗng, bài lạ/nháp 404. Tìm `q` không dấu qua `app_private.f_unaccent`, ký tự đại diện LIKE bị vô hiệu.
- **Cảnh báo lớp `TT29_PRIMARY_ACADEMIC`** (US-9.3): `POST /classes` điền `warnings` cho lớp khối 1–5. Hợp đồng chưa có `subject_kind` nên nhận diện môn nghệ thuật/thể thao/kỹ năng sống theo từ khóa trong tên môn (không dấu, không phân biệt hoa thường), còn lại coi là văn hóa (thà cảnh báo thừa); nâng lên cột `subject_kind` khi hợp đồng thêm trường. `warning-acknowledgements` kiểm mã nằm trong cảnh báo hiện có của lớp (khác → 422), ghi `acknowledgements` (`kind = class_warning`, thêm cột `code` để mỗi mã một dòng, unique nên gọi lại không ghi trùng), bảng chỉ ghi thêm.
- **Migration `0038_compliance`** (4 bảng, RLS + FORCE, audit trigger cho `compliance_items` và `tax_threshold_alerts`), đứng sau `0037_files_etag_audit_exclude` của #208.
