Closes #

## Thay đổi

## Definition of Done (Mục 6.2)

- [ ] D1 — Mọi AC đạt, demo được end-to-end trên môi trường dev (không mock)
- [ ] D2 — CI xanh (lint, typecheck, test, `flutter analyze` 0 lỗi, `oasdiff`, kiểm RLS)
- [ ] D3 — Test: unit cho domain/use case/Cubit; integration cho mọi endpoint ghi (quyền, validate, idempotency); coverage ≥ 80%
- [ ] D4 — `openapi.json`, `error_codes.json` cập nhật; client sinh lại hằng số; không hard-code chuỗi/màu/khoảng cách
- [ ] D5 — Giao diện khớp HiFi; vùng chạm ≥ 44 px; cỡ chữ 130% không vỡ; trạng thái không chỉ dựa vào màu
- [ ] D6 — Không log PII (tên học sinh, SĐT, email, token, OTP) ở log, Sentry, Crashlytics, analytics
- [ ] D7 — Migration (nếu có) tương thích ngược, chạy được trên CSDL trống và dữ liệu seed
- [ ] D9 — Tài liệu (`docs/`, ADR) cập nhật nếu có quyết định mới
- [ ] D10 — Phần làm dở nằm sau feature flag

D8 (QA) kiểm trên issue Story, không phải trên PR.

<!-- Story có Risk tags: thêm checklist bổ sung Mục 6.4–6.7 của kế hoạch triển khai. -->

## Migration (bỏ nếu không có — Mục 6.3)

- [ ] Chỉ thêm (bảng, cột tùy chọn/có default, index), không xóa/đổi tên trong cùng bản phát hành
- [ ] Có `tenant_id` (và `branch_id` nếu thuộc chi nhánh), cột chuẩn đầy đủ, khóa chính UUID v7
- [ ] `enable` + `force row level security`, policy cho `teachhub_app`
- [ ] Index truy vấn chính bắt đầu bằng `tenant_id`; index lớn dùng `CREATE INDEX CONCURRENTLY` (migration riêng)
- [ ] Tiền `bigint`, thời điểm `timestamptz`, ngày học `date`; enum dạng `text + CHECK`
- [ ] Trigger audit gắn vào bảng có dữ liệu nhạy cảm
- [ ] Đã chạy thử trên dữ liệu seed và đo thời gian khóa bảng
