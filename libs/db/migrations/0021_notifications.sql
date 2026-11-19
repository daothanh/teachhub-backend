CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_token_unique" UNIQUE("token"),
	CONSTRAINT "devices_platform_check" CHECK ("devices"."platform" in ('android', 'ios', 'web'))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_channel_check" CHECK ("notification_deliveries"."channel" in ('push', 'web_push', 'email', 'in_app')),
	CONSTRAINT "notification_deliveries_status_check" CHECK ("notification_deliveries"."status" in ('queued', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"channel" text NOT NULL,
	"title_tpl" text NOT NULL,
	"body_tpl" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_templates_type_channel_version_uq" UNIQUE("type","channel","version"),
	CONSTRAINT "notification_templates_channel_check" CHECK ("notification_templates"."channel" in ('push', 'web_push', 'email', 'in_app'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"membership_id" uuid,
	"type" text NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_recipient_dedupe_uq" UNIQUE("recipient_user_id","dedupe_key"),
	CONSTRAINT "notifications_urgency_check" CHECK ("notifications"."urgency" in ('urgent', 'normal'))
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "devices_last_seen_idx" ON "devices" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_notification_channel_uq" ON "notification_deliveries" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread_idx" ON "notifications" USING btree ("recipient_user_id","membership_id") WHERE "notifications"."read_at" is null;
--> statement-breakpoint
-- RLS. Worker (BYPASSRLS) ghi thông báo, nhật ký gửi và đọc thiết bị; api chỉ đụng dòng của chính user.

-- Mẫu: dùng chung, ai cũng đọc, chỉ migration (owner) ghi.
alter table notification_templates enable row level security;
--> statement-breakpoint
alter table notification_templates force row level security;
--> statement-breakpoint
create policy notification_templates_read on notification_templates for select to teachhub_app, teachhub_worker using (true);
--> statement-breakpoint
create policy notification_templates_owner_all on notification_templates for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint

-- Thông báo: người nhận đọc và đánh dấu đã đọc dòng của mình. api không tạo/xóa thông báo và chỉ sửa được `read_at`.
alter table notifications enable row level security;
--> statement-breakpoint
alter table notifications force row level security;
--> statement-breakpoint
create policy notifications_recipient_read on notifications for select to teachhub_app
  using (recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
create policy notifications_recipient_update on notifications for update to teachhub_app
  using (recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
revoke insert, update, delete on notifications from teachhub_app;
--> statement-breakpoint
grant update (read_at) on notifications to teachhub_app;
--> statement-breakpoint

-- Nhật ký gửi: chỉ worker. api không có policy → 0 dòng.
alter table notification_deliveries enable row level security;
--> statement-breakpoint
alter table notification_deliveries force row level security;
--> statement-breakpoint
revoke all on notification_deliveries from teachhub_app;
--> statement-breakpoint

-- Thiết bị: user chỉ thấy và xóa token của mình. Đăng ký (có thể chuyển token đang gắn user khác) đi qua hàm
-- security definer; owner cần policy riêng vì hàm chạy bằng owner cũng bị FORCE RLS.
alter table devices enable row level security;
--> statement-breakpoint
alter table devices force row level security;
--> statement-breakpoint
create policy devices_self on devices for all to teachhub_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
create policy devices_owner_all on devices for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
revoke insert, update on devices from teachhub_app;
--> statement-breakpoint

-- Danh tính lấy từ app.user_id (không nhận tham số userId): không ai đăng ký token thay người khác.
-- Xóa gắn kết cũ của token rồi upsert theo token trong cùng giao dịch; đăng ký lặp cùng token → 1 dòng.
create or replace function app_private.register_device(p_id uuid, p_token text, p_platform text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  if uid is null then
    raise exception 'thiếu app.user_id' using errcode = 'insufficient_privilege';
  end if;
  delete from public.devices where token = p_token and user_id <> uid;
  insert into public.devices (id, user_id, platform, token)
    values (p_id, uid, p_platform, p_token)
    on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now();
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.register_device(uuid, text, text) from teachhub_worker, teachhub_readonly, public;
