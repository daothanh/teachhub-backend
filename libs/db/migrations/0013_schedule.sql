CREATE TABLE "schedule_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" time NOT NULL,
	"duration_min" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_rules_class_weekday_start_uq" UNIQUE("class_id","weekday","start_time"),
	CONSTRAINT "schedule_rules_weekday_check" CHECK ("schedule_rules"."weekday" between 1 and 7),
	CONSTRAINT "schedule_rules_duration_check" CHECK ("schedule_rules"."duration_min" between 15 and 480),
	CONSTRAINT "schedule_rules_within_day_check" CHECK (extract(epoch from "schedule_rules"."start_time") / 60 + "schedule_rules"."duration_min" <= 1440)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"rule_id" uuid,
	"session_date" date NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"is_makeup" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_rule_date_uq" UNIQUE("rule_id","session_date"),
	CONSTRAINT "sessions_status_check" CHECK ("sessions"."status" in ('planned', 'taught', 'cancelled')),
	CONSTRAINT "sessions_time_check" CHECK ("sessions"."ends_at" > "sessions"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_tenant_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_rule_id_schedule_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."schedule_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_tenant_date_idx" ON "sessions" USING btree ("tenant_id","session_date","starts_at");--> statement-breakpoint
CREATE INDEX "sessions_class_date_idx" ON "sessions" USING btree ("class_id","session_date");
--> statement-breakpoint

-- RLS: nhân sự tenant đọc/ghi lịch của tenant mình; user khác và thiếu app.user_id thấy 0 dòng.
alter table schedule_rules enable row level security;
--> statement-breakpoint
alter table schedule_rules force row level security;
--> statement-breakpoint
create policy schedule_rules_staff_all on schedule_rules for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create trigger trg_schedule_rules_updated_at before update on schedule_rules
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
alter table sessions enable row level security;
--> statement-breakpoint
alter table sessions force row level security;
--> statement-breakpoint
create policy sessions_staff_all on sessions for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create trigger trg_sessions_updated_at before update on sessions
  for each row execute function app_private.set_updated_at();
