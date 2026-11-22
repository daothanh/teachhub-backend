CREATE TABLE "acknowledgements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"code" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acknowledgements_entity_code_uq" UNIQUE("tenant_id","kind","entity_id","code"),
	CONSTRAINT "acknowledgements_kind_check" CHECK ("acknowledgements"."kind" in ('class_warning'))
);
--> statement-breakpoint
CREATE TABLE "compliance_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"status" text NOT NULL,
	"data" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_items_tenant_key_uq" UNIQUE("tenant_id","item_key"),
	CONSTRAINT "compliance_items_key_check" CHECK ("compliance_items"."item_key" in ('business_registration', 'registration_number', 'public_disclosure', 'school_declaration')),
	CONSTRAINT "compliance_items_status_check" CHECK ("compliance_items"."status" in ('todo', 'done', 'not_applicable')),
	CONSTRAINT "compliance_items_completed_check" CHECK (("compliance_items"."status" = 'done') = ("compliance_items"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "legal_articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body_markdown" text NOT NULL,
	"sources" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reviewed_by" text,
	"reviewer_role" text,
	"reviewed_on" date,
	"published_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_articles_slug_uq" UNIQUE("slug"),
	CONSTRAINT "legal_articles_status_check" CHECK ("legal_articles"."status" in ('draft', 'published')),
	CONSTRAINT "legal_articles_reviewer_role_check" CHECK ("legal_articles"."reviewer_role" is null or "legal_articles"."reviewer_role" in ('lawyer', 'accountant')),
	CONSTRAINT "legal_articles_published_check" CHECK ("legal_articles"."status" <> 'published' or ("legal_articles"."reviewed_by" is not null and "legal_articles"."reviewer_role" is not null and "legal_articles"."reviewed_on" is not null and "legal_articles"."published_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tax_threshold_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fiscal_year" integer NOT NULL,
	"milestone" text NOT NULL,
	"payment_id" uuid,
	"cumulative_amount" bigint NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_threshold_alerts_tenant_year_milestone_uq" UNIQUE("tenant_id","fiscal_year","milestone"),
	CONSTRAINT "tax_threshold_alerts_milestone_check" CHECK ("tax_threshold_alerts"."milestone" in ('400m', '800m')),
	CONSTRAINT "tax_threshold_alerts_year_check" CHECK ("tax_threshold_alerts"."fiscal_year" between 2020 and 2100)
);
--> statement-breakpoint
ALTER TABLE "acknowledgements" ADD CONSTRAINT "acknowledgements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledgements" ADD CONSTRAINT "acknowledgements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_items" ADD CONSTRAINT "compliance_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_threshold_alerts" ADD CONSTRAINT "tax_threshold_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_threshold_alerts" ADD CONSTRAINT "tax_threshold_alerts_tenant_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_articles_published_idx" ON "legal_articles" USING btree ("published_at");--> statement-breakpoint
-- S8 compliance (US-9.1, 9.3, 9.5, 9.6): RLS + FORCE cả bốn bảng. Nhân sự tenant đọc; chỉ chủ tenant ghi (khớp controller `tenant_owner`).
-- Job `compliance.tax-threshold` chạy bằng role worker (BYPASSRLS) và lọc `tenant_id` tường minh.
alter table compliance_items enable row level security;
--> statement-breakpoint
alter table compliance_items force row level security;
--> statement-breakpoint
create policy compliance_items_staff_read on compliance_items for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy compliance_items_owner_insert on compliance_items for insert to teachhub_app
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint
create policy compliance_items_owner_update on compliance_items for update to teachhub_app
  using (tenant_id in (select app_private.owner_tenant_ids()))
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint
create policy compliance_items_owner_all on compliance_items for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
revoke delete, truncate on compliance_items from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint
create trigger trg_compliance_items_updated_at before update on compliance_items
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
select app_private.enable_audit('compliance_items');
--> statement-breakpoint

alter table tax_threshold_alerts enable row level security;
--> statement-breakpoint
alter table tax_threshold_alerts force row level security;
--> statement-breakpoint
create policy tax_threshold_alerts_staff_read on tax_threshold_alerts for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
-- Cảnh báo sinh lười khi chủ tenant mở sổ doanh thu (ngoài ra là job worker); đóng cảnh báo = UPDATE `dismissed_at`.
create policy tax_threshold_alerts_owner_insert on tax_threshold_alerts for insert to teachhub_app
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint
create policy tax_threshold_alerts_owner_update on tax_threshold_alerts for update to teachhub_app
  using (tenant_id in (select app_private.owner_tenant_ids()))
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint
create policy tax_threshold_alerts_owner_all on tax_threshold_alerts for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
revoke delete, truncate on tax_threshold_alerts from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint
select app_private.enable_audit('tax_threshold_alerts');
--> statement-breakpoint

alter table acknowledgements enable row level security;
--> statement-breakpoint
alter table acknowledgements force row level security;
--> statement-breakpoint
create policy acknowledgements_staff_read on acknowledgements for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy acknowledgements_owner_insert on acknowledgements for insert to teachhub_app
  with check (tenant_id in (select app_private.owner_tenant_ids())
    and user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
create policy acknowledgements_owner_all on acknowledgements for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
-- Nhật ký chỉ ghi thêm.
revoke update, delete, truncate on acknowledgements from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint

-- Thư viện quy định dùng chung toàn hệ thống (không có tenant_id): app chỉ đọc bài đã phát hành và đã có người duyệt (US-9.6 AC3).
-- Soạn/phát hành thuộc task admin (đường đặc quyền worker/owner, không qua teachhub_app).
alter table legal_articles enable row level security;
--> statement-breakpoint
alter table legal_articles force row level security;
--> statement-breakpoint
create policy legal_articles_published_read on legal_articles for select to teachhub_app
  using (status = 'published' and reviewed_by is not null);
--> statement-breakpoint
create policy legal_articles_owner_all on legal_articles for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
revoke insert, update, delete, truncate on legal_articles from teachhub_app, teachhub_readonly;
--> statement-breakpoint
create trigger trg_legal_articles_updated_at before update on legal_articles
  for each row execute function app_private.set_updated_at();
