-- RLS cho outbox_events (bảng hạ tầng): api chỉ INSERT, và chỉ vào tenant mà user là nhân sự (cùng quy ước 0006_tenancy_rls).
-- Worker (BYPASSRLS) đọc/cập nhật/xóa khi relay và dọn dẹp.
-- shortcut: sự kiện do phụ huynh/học sinh phát sinh (Sprint 4+) chưa phải nhân sự nên bị policy chặn, cần hàm security definer khi tới S4.
alter table outbox_events enable row level security;
--> statement-breakpoint
alter table outbox_events force row level security;
--> statement-breakpoint
create policy outbox_events_staff_insert on outbox_events for insert to teachhub_app
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
revoke select, update, delete on outbox_events from teachhub_app;
--> statement-breakpoint
-- Bảng nhiều UPDATE/DELETE (lease, đánh dấu gửi, dọn): chừa chỗ cho HOT update và vacuum sớm.
alter table outbox_events set (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
