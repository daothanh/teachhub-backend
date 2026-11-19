-- RLS cho outbox_events (bảng hạ tầng, như job_runs): api chỉ được INSERT (cùng giao dịch với lệnh nghiệp vụ),
-- worker (BYPASSRLS) đọc/cập nhật khi relay.
alter table outbox_events enable row level security;
--> statement-breakpoint
alter table outbox_events force row level security;
--> statement-breakpoint
create policy outbox_events_app_insert on outbox_events for insert to teachhub_app with check (true);
--> statement-breakpoint
revoke select, update, delete on outbox_events from teachhub_app;
