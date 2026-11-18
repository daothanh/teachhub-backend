CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"code" text PRIMARY KEY NOT NULL,
	"limits" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_code" text NOT NULL,
	"status" text DEFAULT 'free' NOT NULL,
	"trial_used_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"source" text,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_tenantId_unique" UNIQUE("tenant_id"),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('free', 'trialing', 'active', 'expired')),
	CONSTRAINT "subscriptions_source_check" CHECK ("subscriptions"."source" is null or "subscriptions"."source" in ('app_store', 'play_store', 'bank_transfer'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL,
	"business_reg_no" text,
	"teaches_at_school" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenants_type_check" CHECK ("tenants"."type" in ('teacher', 'center', 'chain'))
);
--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branches_tenant_default_uq" ON "branches" USING btree ("tenant_id") WHERE "branches"."is_default";--> statement-breakpoint
CREATE INDEX "branches_tenant_id_idx" ON "branches" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;