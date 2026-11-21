CREATE TABLE "bank_transfer_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_code" text NOT NULL,
	"amount" bigint NOT NULL,
	"transfer_note" text NOT NULL,
	"payee" jsonb NOT NULL,
	"qr_payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"bank_transaction_ref" text,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transfer_orders_status_check" CHECK ("bank_transfer_orders"."status" in ('pending', 'confirmed')),
	CONSTRAINT "bank_transfer_orders_amount_check" CHECK ("bank_transfer_orders"."amount" > 0),
	CONSTRAINT "bank_transfer_orders_note_check" CHECK ("bank_transfer_orders"."transfer_note" ~ '^[A-Z0-9 ]{1,25}$')
);
--> statement-breakpoint
CREATE TABLE "plan_features" (
	"plan_code" text NOT NULL,
	"feature_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "plan_features_plan_code_feature_key_pk" PRIMARY KEY("plan_code","feature_key")
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"event_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_events_outcome_check" CHECK ("subscription_events"."outcome" in ('processed', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "tenant_feature_overrides" (
	"tenant_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_feature_overrides_tenant_id_feature_key_pk" PRIMARY KEY("tenant_id","feature_key")
);
--> statement-breakpoint
ALTER TABLE "bank_transfer_orders" ADD CONSTRAINT "bank_transfer_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_orders" ADD CONSTRAINT "bank_transfer_orders_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_feature_overrides" ADD CONSTRAINT "tenant_feature_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transfer_orders_pending_uq" ON "bank_transfer_orders" USING btree ("tenant_id") WHERE "bank_transfer_orders"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transfer_orders_note_uq" ON "bank_transfer_orders" USING btree ("transfer_note");--> statement-breakpoint
CREATE INDEX "bank_transfer_orders_status_idx" ON "bank_transfer_orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_events_event_id_uq" ON "subscription_events" USING btree ("source","event_id");--> statement-breakpoint
CREATE INDEX "subscription_events_tenant_idx" ON "subscription_events" USING btree ("tenant_id","event_at");-- S7-BE (US-0.7, US-0.8): feature flag, sự kiện thuê bao, đơn chuyển khoản. RLS + FORCE cả bốn bảng.
-- `subscriptions` chỉ đổi qua hàm security definer bên dưới (dùng thử, webhook RevenueCat): app không UPDATE trực tiếp.
alter table plan_features enable row level security;
--> statement-breakpoint
alter table plan_features force row level security;
--> statement-breakpoint
create policy plan_features_read on plan_features for select to teachhub_app, teachhub_worker using (true);
--> statement-breakpoint
create policy plan_features_owner_all on plan_features for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
alter table tenant_feature_overrides enable row level security;
--> statement-breakpoint
alter table tenant_feature_overrides force row level security;
--> statement-breakpoint
create policy tenant_feature_overrides_staff_read on tenant_feature_overrides for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy tenant_feature_overrides_owner_all on tenant_feature_overrides for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
alter table subscription_events enable row level security;
--> statement-breakpoint
alter table subscription_events force row level security;
--> statement-breakpoint
create policy subscription_events_staff_read on subscription_events for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy subscription_events_owner_all on subscription_events for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
alter table bank_transfer_orders enable row level security;
--> statement-breakpoint
alter table bank_transfer_orders force row level security;
--> statement-breakpoint
create policy bank_transfer_orders_staff_read on bank_transfer_orders for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
-- Chỉ chủ tenant tạo đơn (đúng controller `tenant_owner`), luôn `pending`; xác nhận do quản trị qua đường đặc quyền.
create policy bank_transfer_orders_owner_insert on bank_transfer_orders for insert to teachhub_app
  with check (tenant_id in (select app_private.owner_tenant_ids()) and status = 'pending'
    and created_by = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
create policy bank_transfer_orders_owner_all on bank_transfer_orders for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
revoke delete, truncate on bank_transfer_orders, subscription_events from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint
create trigger trg_bank_transfer_orders_updated_at before update on bank_transfer_orders
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
select app_private.enable_audit('bank_transfer_orders');
--> statement-breakpoint

insert into plan_features (plan_code, feature_key, enabled) values
  ('free', 'compliance.form02', false), ('free', 'compliance.form03', false),
  ('free', 'revenue.export', false), ('free', 'reports.export', false),
  ('pro', 'compliance.form02', true), ('pro', 'compliance.form03', true),
  ('pro', 'revenue.export', true), ('pro', 'reports.export', true);
--> statement-breakpoint

-- Dùng thử Pro 14 ngày (US-0.8 AC1). Chủ tenant lấy từ app.user_id; khóa dòng subscription nên hai request song song
-- chỉ một request thắng. Trả: started | conflict (đang trialing/active còn hạn) | trial_used.
create or replace function app_private.start_trial(p_tenant_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  if p_tenant_id not in (select app_private.owner_tenant_ids()) then
    raise exception 'start_trial: không phải chủ tenant' using errcode = '42501';
  end if;
  select * into s from public.subscriptions where tenant_id = p_tenant_id for update;
  if not found then raise exception 'start_trial: tenant chưa có subscription' using errcode = '42501'; end if;
  if s.status in ('trialing', 'active') and (s.current_period_end is null or s.current_period_end > now()) then
    return 'conflict';
  end if;
  if s.trial_used_at is not null then return 'trial_used'; end if;
  update public.subscriptions
     set plan_code = 'pro', status = 'trialing', trial_used_at = now(),
         current_period_end = now() + interval '14 days', source = null
   where id = s.id;
  return 'started';
end;
$$;
--> statement-breakpoint

-- Webhook RevenueCat (không có user): bước 1 khóa subscription của tenant, ghi sự kiện (idempotent theo event_id), trả trạng thái
-- hiện tại để TS quyết định. Trả jsonb {result: unknown_tenant | duplicate | ok, ...}.
create or replace function app_private.rc_begin_event(
  p_event_id text, p_tenant_id uuid, p_type text, p_event_at timestamptz, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; last_at timestamptz; inserted int;
begin
  select * into s from public.subscriptions where tenant_id = p_tenant_id for update;
  if not found then return jsonb_build_object('result', 'unknown_tenant'); end if;
  select max(event_at) into last_at from public.subscription_events
   where tenant_id = p_tenant_id and source = 'revenuecat' and outcome = 'processed';
  insert into public.subscription_events (id, tenant_id, source, event_id, type, outcome, event_at, payload)
    values (gen_random_uuid(), p_tenant_id, 'revenuecat', p_event_id, p_type, 'ignored', p_event_at, p_payload)
    on conflict (source, event_id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return jsonb_build_object('result', 'duplicate'); end if;
  return jsonb_build_object('result', 'ok', 'status', s.status, 'source', s.source,
    'currentPeriodEnd', s.current_period_end, 'lastAppliedAt', last_at);
end;
$$;
--> statement-breakpoint

-- Bước 2: áp dụng quyết định lên subscriptions + đánh dấu sự kiện `processed` (cùng giao dịch với bước 1).
create or replace function app_private.rc_apply_event(
  p_event_id text, p_tenant_id uuid, p_plan_code text, p_status text, p_source text,
  p_period_end timestamptz, p_external_ref text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.subscriptions
     set plan_code = p_plan_code, status = p_status, source = p_source,
         current_period_end = p_period_end, external_ref = p_external_ref
   where tenant_id = p_tenant_id;
  update public.subscription_events set outcome = 'processed'
   where source = 'revenuecat' and event_id = p_event_id and tenant_id = p_tenant_id;
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.start_trial(uuid), app_private.rc_begin_event(text, uuid, text, timestamptz, jsonb),
  app_private.rc_apply_event(text, uuid, text, text, text, timestamptz, text)
  from teachhub_worker, teachhub_readonly, public;
