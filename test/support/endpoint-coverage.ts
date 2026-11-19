/**
 * S1-BE-09 / Plan §6.4: mỗi endpoint trong contracts/openapi.json phải khai ở đây test chéo user/tenant của
 * nó (file + tên test có thật) hoặc lý do không cần. Endpoint mới chưa khai → test endpoint-coverage đỏ.
 * Route cần token được thử tự động không token / token rác / token khóa lạ → 401.
 */
export type CrossCoverage =
  { file: string; test: string } | { notApplicable: string };

export const ENDPOINT_COVERAGE: Record<string, CrossCoverage> = {
  'GET /v1/app-config': {
    notApplicable: 'công khai, cấu hình chung, không có dữ liệu user',
  },
  'POST /v1/auth/otp/send': {
    notApplicable: 'công khai; luôn 204, không lộ email đã có tài khoản',
  },
  'POST /v1/auth/login': {
    file: 'auth-otp.e2e-spec.ts',
    test: 'không có mã thì nhập sai không đếm: người lạ không khóa được email người khác',
  },
  'POST /v1/auth/sso/google': {
    file: 'auth-google.e2e-spec.ts',
    test: 'email không phải Gmail/Workspace trùng user có sẵn → không gộp, yêu cầu OTP',
  },
  'POST /v1/auth/refresh': {
    file: 'auth-session.e2e-spec.ts',
    test: 'dùng lại token đã xoay → 401 và thu hồi cả họ (token mới cũng chết)',
  },
  'POST /v1/auth/logout': {
    file: 'auth-session.e2e-spec.ts',
    test: 'logout thu hồi phiên hiện tại, không đụng phiên khác của cùng user',
  },
  'GET /v1/auth/me': {
    file: 'endpoint-coverage.e2e-spec.ts',
    test: 'đọc dữ liệu "của tôi": token A chỉ ra dữ liệu A, token B chỉ ra B',
  },
  'GET /v1/me/memberships': {
    file: 'endpoint-coverage.e2e-spec.ts',
    test: 'đọc dữ liệu "của tôi": token A chỉ ra dữ liệu A, token B chỉ ra B',
  },
  'PUT /v1/me/active-membership': {
    file: 'me.e2e-spec.ts',
    test: 'active-membership: lưu vai trò của mình; vai trò người khác/đã thu hồi → 404',
  },
  'POST /v1/me/roles': {
    file: 'identity.e2e-spec.ts',
    test: 'A không tự cấp vai trò nhân sự, kể cả ở tenant của mình',
  },
  'POST /v1/workspaces': {
    file: 'workspaces.e2e-spec.ts',
    test: 'app không tự gọi được hàm tạo không gian cho user khác (lấy user từ app.user_id)',
  },
  'GET /v1/onboarding': {
    file: 'onboarding.e2e-spec.ts',
    test: 'chéo tenant: trạng thái của A không lộ sang B và PATCH của B không đổi A',
  },
  'PATCH /v1/onboarding/steps/{step}': {
    file: 'onboarding.e2e-spec.ts',
    test: 'chéo tenant: trạng thái của A không lộ sang B và PATCH của B không đổi A',
  },
  'POST /v1/center-waitlist': {
    file: 'center-waitlist.e2e-spec.ts',
    test: 'user khác dùng cùng Idempotency-Key vẫn tạo bản ghi riêng; RLS chặn đọc/sửa/xóa bản của người khác',
  },
  'POST /v1/auth/sso/apple': {
    file: 'auth-apple.e2e-spec.ts',
    test: 'email chưa xác minh trùng user có sẵn → không gộp, không tạo, yêu cầu OTP',
  },
  'GET /v1/classes': {
    file: 'classes.e2e-spec.ts',
    test: 'tenant B không xem/sửa/lưu trữ lớp của A → 404, lớp A không đổi; danh sách B trống',
  },
  'POST /v1/classes': {
    file: 'classes.e2e-spec.ts',
    test: 'id client gửi trùng id lớp của tenant khác → 409, không lộ và không ghi đè',
  },
  'GET /v1/classes/{id}': {
    file: 'classes.e2e-spec.ts',
    test: 'tenant B không xem/sửa/lưu trữ lớp của A → 404, lớp A không đổi; danh sách B trống',
  },
  'PATCH /v1/classes/{id}': {
    file: 'classes.e2e-spec.ts',
    test: 'tenant B không xem/sửa/lưu trữ lớp của A → 404, lớp A không đổi; danh sách B trống',
  },
  'POST /v1/classes/{id}/archive': {
    file: 'classes.e2e-spec.ts',
    test: 'tenant B không xem/sửa/lưu trữ lớp của A → 404, lớp A không đổi; danh sách B trống',
  },
  'GET /v1/classes/{id}/roster': {
    file: 'enrollments.e2e-spec.ts',
    test: 'studentId của tenant khác trả cùng mã và nội dung với studentId không tồn tại; không ghi danh chéo tenant',
  },
  'POST /v1/classes/{id}/enrollments': {
    file: 'enrollments.e2e-spec.ts',
    test: 'studentId của tenant khác trả cùng mã và nội dung với studentId không tồn tại; không ghi danh chéo tenant',
  },
  'GET /v1/students': {
    file: 'students.e2e-spec.ts',
    test: 'tenant B không sửa học viên của A (404) và không thấy trong danh sách/tìm kiếm',
  },
  'POST /v1/students': {
    file: 'students.e2e-spec.ts',
    test: 'ứng viên trùng tối đa 5 và chỉ trong tenant: hồ sơ cùng tên + ngày sinh ở tenant khác không lộ',
  },
  'PATCH /v1/students/{id}': {
    file: 'students.e2e-spec.ts',
    test: 'tenant B không sửa học viên của A (404) và không thấy trong danh sách/tìm kiếm',
  },
  'PUT /v1/classes/{id}/schedule-rules': {
    file: 'schedule.e2e-spec.ts',
    test: 'tenant B không đặt lịch cho lớp của A (404), không thấy buổi của A, lọc theo classId của A cho danh sách rỗng',
  },
  'GET /v1/sessions': {
    file: 'schedule.e2e-spec.ts',
    test: 'tenant B không đặt lịch cho lớp của A (404), không thấy buổi của A, lọc theo classId của A cho danh sách rỗng',
  },
  'GET /v1/admin/bank-transfer-orders': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới task admin; test chéo tenant làm cùng task đó',
  },
  'POST /v1/admin/bank-transfer-orders/{id}/confirm': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới task admin; test chéo tenant làm cùng task đó',
  },
  'GET /v1/admin/legal-articles': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới task admin; test chéo tenant làm cùng task đó',
  },
  'POST /v1/admin/legal-articles': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới task admin; test chéo tenant làm cùng task đó',
  },
  'POST /v1/admin/legal-articles/{id}/publish': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới task admin; test chéo tenant làm cùng task đó',
  },
  'GET /v1/admin/support/tenants/{id}': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới task admin; test chéo tenant làm cùng task đó',
  },
  'GET /v1/sessions/{id}/attendance': {
    file: 'attendance.e2e-spec.ts',
    test: 'chéo tenant: B không đọc/ghi buổi của A (404); học viên tenant khác và học viên ngoài lớp cho cùng kết quả',
  },
  'POST /v1/attendance/sync': {
    file: 'attendance.e2e-spec.ts',
    test: 'chéo tenant: B không đọc/ghi buổi của A (404); học viên tenant khác và học viên ngoài lớp cho cùng kết quả',
  },
  'GET /v1/sessions/{id}/attendance/history': {
    file: 'attendance.e2e-spec.ts',
    test: 'nhật ký chéo tenant: B không xem được buổi của A (404); chỉ tenant_owner xem được (giáo viên thường 403)',
  },
  'POST /v1/push/register': {
    file: 'push.e2e-spec.ts',
    test: 'chéo tenant: userId trong body khác token → 403 FORBIDDEN, không ghi gì',
  },
  'POST /v1/push/unregister': {
    file: 'push.e2e-spec.ts',
    test: 'chéo tenant: userId trong body khác token → 403 FORBIDDEN, không ghi gì',
  },
  'GET /v1/notifications': {
    file: 'notifications.e2e-spec.ts',
    test: 'GET /notifications: chỉ của chính user; chéo user thấy rỗng',
  },
  'POST /v1/notifications/read': {
    file: 'notifications.e2e-spec.ts',
    test: 'POST /notifications/read: chéo user bị bỏ qua',
  },
  'POST /v1/students/{id}/invites': {
    file: 'invites.e2e-spec.ts',
    test: 'guardianId không thuộc học viên',
  },
  'GET /v1/students/{id}/invites': {
    file: 'invites.e2e-spec.ts',
    test: 'chỉ lưu băm',
  },
  'POST /v1/invites/{id}/revoke': {
    file: 'invites.e2e-spec.ts',
    test: 'thu hồi: idempotent',
  },
  'POST /v1/invites/{id}/resend': {
    file: 'invites.e2e-spec.ts',
    test: 'thu hồi: idempotent',
  },
  'POST /v1/invites/redeem-code': {
    file: 'invites.e2e-spec.ts',
    test: 'mã ngắn: không phân biệt hoa/thường',
  },
  'POST /v1/consents': {
    file: 'invites.e2e-spec.ts',
    test: 'ghi thêm dòng; trùng',
  },
  'GET /v1/consents/status': {
    file: 'invites.e2e-spec.ts',
    test: 'phiên bản khác hiện hành',
  },
  'GET /v1/family/students': {
    file: 'family.e2e-spec.ts',
    test: 'danh sách con gộp mọi giáo viên',
  },
  'GET /v1/family/students/{id}/attendance': {
    file: 'family.e2e-spec.ts',
    test: 'cross-parent / cross-tenant',
  },
  'POST /v1/web-push/subscriptions': {
    notApplicable:
      'hợp đồng S3-FL-12, thân hàm trả 501 tới S4-BE-08b; test chéo tenant/học viên làm cùng task đó',
  },
  'POST /v1/web-push/unsubscribe': {
    notApplicable:
      'hợp đồng S3-FL-12, thân hàm trả 501 tới S4-BE-08b; test chéo tenant/học viên làm cùng task đó',
  },
  'POST /v1/invites/preview': {
    file: 'invites.e2e-spec.ts',
    test: 'preview công khai chỉ trả',
  },
  'POST /v1/invites/accept': {
    file: 'invites.e2e-spec.ts',
    test: 'nhận thành công',
  },
  'POST /v1/sessions/{id}/reschedule': {
    notApplicable:
      'hợp đồng S3-FL-12, thân hàm trả 501 tới S4-BE-07; test chéo tenant/học viên làm cùng task đó',
  },
  'POST /v1/sessions/{id}/cancel': {
    notApplicable:
      'hợp đồng S3-FL-12, thân hàm trả 501 tới S4-BE-07; test chéo tenant/học viên làm cùng task đó',
  },
  'POST /v1/sessions/{id}/makeup': {
    notApplicable:
      'hợp đồng S3-FL-12, thân hàm trả 501 tới S4-BE-07; test chéo tenant/học viên làm cùng task đó',
  },
  'DELETE /v1/me': {
    notApplicable:
      'hợp đồng S3-FL-12, thân hàm trả 501 tới S4-BE-09; test chéo tenant/học viên làm cùng task đó',
  },
};
