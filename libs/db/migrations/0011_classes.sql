CREATE TABLE "classes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"grade" integer NOT NULL,
	"mode" text NOT NULL,
	"location" text,
	"capacity" integer,
	"start_date" date NOT NULL,
	"end_date" date,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classes_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "classes_grade_check" CHECK ("classes"."grade" between 1 and 12),
	CONSTRAINT "classes_mode_check" CHECK ("classes"."mode" in ('offline', 'online')),
	CONSTRAINT "classes_status_check" CHECK ("classes"."status" in ('active', 'archived')),
	CONSTRAINT "classes_capacity_check" CHECK ("classes"."capacity" is null or "classes"."capacity" > 0),
	CONSTRAINT "classes_end_date_check" CHECK ("classes"."end_date" is null or "classes"."end_date" >= "classes"."start_date"),
	CONSTRAINT "classes_offline_location_check" CHECK ("classes"."mode" <> 'offline' or nullif(trim("classes"."location"), '') is not null)
);
--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_tenant_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classes_tenant_status_idx" ON "classes" USING btree ("tenant_id","status");--> statement-breakpoint

-- RLS (Technical Spec §4.5): nhân sự tenant đọc/ghi lớp của tenant mình; user khác và thiếu app.user_id thấy 0 dòng.
alter table classes enable row level security;
--> statement-breakpoint
alter table classes force row level security;
--> statement-breakpoint
create policy classes_staff_all on classes for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create trigger trg_classes_updated_at before update on classes
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
-- Lưu trữ lớp, đổi ngày/hình thức ảnh hưởng lịch và học phí → audit.
select app_private.enable_audit('classes');
