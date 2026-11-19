# Việc tồn đọng của backend

## Dọn dữ liệu theo thời hạn (chưa có job)

- `notifications` và `notification_deliveries` chưa bị xóa theo tuổi. Cần quy định thời hạn giữ rồi thêm job cron, xóa theo lô như job dọn `outbox_events`.
- `outbox_events` đã gửi được dọn sau 7 ngày. Sự kiện `failed_at` (hết lượt thử) chưa có người xem và chưa có chỗ dọn.
- `audit_logs` của `attendance` giữ nguyên cả ghi chú điểm danh (`note`). Cần quyết định thời hạn giữ và có che ghi chú ở bản ghi cũ hay không.
