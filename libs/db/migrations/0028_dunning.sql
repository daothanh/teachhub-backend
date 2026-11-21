CREATE TABLE "dunning_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"offset_days" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dunning_jobs_invoice_offset_uq" UNIQUE("invoice_id","offset_days"),
	CONSTRAINT "dunning_jobs_status_check" CHECK ("dunning_jobs"."status" in ('pending', 'sent', 'cancelled')),
	CONSTRAINT "dunning_jobs_offset_check" CHECK ("dunning_jobs"."offset_days" between -7 and 30),
	CONSTRAINT "dunning_jobs_sent_check" CHECK (("dunning_jobs"."status" = 'sent') = ("dunning_jobs"."sent_at" is not null)),
	CONSTRAINT "dunning_jobs_cancel_reason_check" CHECK (("dunning_jobs"."status" = 'cancelled') = ("dunning_jobs"."cancel_reason" is not null)
        and ("dunning_jobs"."cancel_reason" is null or "dunning_jobs"."cancel_reason" in ('settled', 'void', 'student_disabled', 'tenant_disabled', 'superseded')))
);
--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "dunning_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "dunning_jobs" ADD CONSTRAINT "dunning_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_jobs" ADD CONSTRAINT "dunning_jobs_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dunning_jobs_tenant_invoice_idx" ON "dunning_jobs" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "dunning_jobs_pending_idx" ON "dunning_jobs" USING btree ("scheduled_for") WHERE "dunning_jobs"."status" = 'pending';--> statement-breakpoint
-- S6-BE-04: lịch nhắc nợ. RLS + FORCE; nhân sự tenant đọc, chỉ chủ tenant lập/hủy/lập lại mốc (khớp controller `tenant_owner`);
-- job `billing.dunning` chạy bằng role worker (BYPASSRLS) và lọc `tenant_id` tường minh. Không xóa dòng: hủy là đổi trạng thái.
alter table dunning_jobs enable row level security;
--> statement-breakpoint
alter table dunning_jobs force row level security;
--> statement-breakpoint
create policy dunning_jobs_staff_read on dunning_jobs for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy dunning_jobs_owner_insert on dunning_jobs for insert to teachhub_app
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint
create policy dunning_jobs_owner_update on dunning_jobs for update to teachhub_app
  using (tenant_id in (select app_private.owner_tenant_ids()))
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint
revoke delete, truncate on dunning_jobs from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint
create trigger trg_dunning_jobs_updated_at before update on dunning_jobs
  for each row execute function app_private.set_updated_at();
