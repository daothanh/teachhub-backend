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
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới S2-BE-10; test chéo tenant làm cùng task đó',
  },
  'PATCH /v1/onboarding/steps/{step}': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới S2-BE-10; test chéo tenant làm cùng task đó',
  },
  'POST /v1/center-waitlist': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới S2-BE-11; test chéo tenant làm cùng task đó',
  },
  'POST /v1/auth/sso/apple': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới S2-BE-01; test chéo tenant làm cùng task đó',
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
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới S2-BE-06b; test chéo tenant làm cùng task đó',
  },
  'POST /v1/classes/{id}/enrollments': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới S2-BE-06; test chéo tenant làm cùng task đó',
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
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới S2-BE-08; test chéo tenant làm cùng task đó',
  },
  'GET /v1/sessions': {
    notApplicable:
      'hợp đồng S1-CT-02, thân hàm trả 501 tới S2-BE-08; test chéo tenant làm cùng task đó',
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
};
