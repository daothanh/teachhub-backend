CREATE TABLE "attendance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"recorded_by" uuid,
	"client_mutation_id" uuid,
	"client_updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_session_student_uq" UNIQUE("session_id","student_id"),
	CONSTRAINT "attendance_tenant_mutation_uq" UNIQUE("tenant_id","client_mutation_id"),
	CONSTRAINT "attendance_status_check" CHECK ("attendance"."status" in ('present', 'late', 'excused', 'unexcused'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_tenant_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_tenant_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_tenant_student_session_idx" ON "attendance" USING btree ("tenant_id","student_id","session_id");
--> statement-breakpoint
-- RLS: nhân sự tenant đọc/ghi điểm danh của tenant mình; user khác và thiếu app.user_id thấy 0 dòng.
alter table attendance enable row level security;
--> statement-breakpoint
alter table attendance force row level security;
--> statement-breakpoint
create policy attendance_staff_all on attendance for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create trigger trg_attendance_updated_at before update on attendance
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
-- Nguồn nhật ký sửa điểm danh (US-3.3 AC2, S3-BE-03): mỗi insert/update ghi audit_logs với before/after,
-- actor lấy từ app.user_id. Dòng chỉ có `note` (ghi chú ≤ 500 ký tự) và trạng thái, không có PII liên hệ.
select app_private.enable_audit('attendance');
--> statement-breakpoint
-- Đọc nhật ký của một buổi theo (tenant, session): lọc trước khi đọc, không quét cả tenant.
create index audit_logs_attendance_session_idx on audit_logs (tenant_id, (coalesce(after_data, before_data) ->> 'session_id'), created_at desc)
  where entity = 'attendance';
