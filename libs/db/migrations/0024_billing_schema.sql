CREATE TABLE "billing_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"close_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'drafting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_periods_tenant_month_uq" UNIQUE("tenant_id","period_month"),
	CONSTRAINT "billing_periods_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_periods_month_check" CHECK ("billing_periods"."period_month" = date_trunc('month', "billing_periods"."period_month")::date),
	CONSTRAINT "billing_periods_status_check" CHECK ("billing_periods"."status" in ('drafting', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"amount" bigint NOT NULL,
	"charged" boolean DEFAULT true NOT NULL,
	"not_charged_reason" text,
	"session_id" uuid,
	"session_date" date,
	"class_name" text,
	"adjustment_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_lines_invoice_position_uq" UNIQUE("invoice_id","position"),
	CONSTRAINT "invoice_lines_kind_check" CHECK ("invoice_lines"."kind" in ('session', 'monthly', 'course_installment', 'carry_over', 'prev_adjustment', 'discount', 'surcharge', 'manual_adjustment')),
	CONSTRAINT "invoice_lines_amount_check" CHECK ("invoice_lines"."amount" between -100000000000 and 100000000000),
	CONSTRAINT "invoice_lines_charged_amount_check" CHECK ("invoice_lines"."charged" or "invoice_lines"."amount" = 0),
	CONSTRAINT "invoice_lines_not_charged_reason_check" CHECK (("invoice_lines"."not_charged_reason" is not null) = ("invoice_lines"."kind" = 'session' and not "invoice_lines"."charged")
        and ("invoice_lines"."not_charged_reason" is null or "invoice_lines"."not_charged_reason" in ('excused_not_charged', 'unexcused_not_charged', 'cancelled', 'makeup'))),
	CONSTRAINT "invoice_lines_adjustment_reason_check" CHECK (("invoice_lines"."adjustment_reason" is not null) = ("invoice_lines"."kind" = 'manual_adjustment'))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"code" text,
	"total_amount" bigint DEFAULT 0 NOT NULL,
	"clamped_amount" bigint DEFAULT 0 NOT NULL,
	"installment_no" integer,
	"installment_count" integer,
	"transfer_note" text,
	"qr_payload" text,
	"payout" jsonb,
	"replaces_invoice_id" uuid,
	"replacement_invoice_id" uuid,
	"void_reason" text,
	"issued_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_tenant_code_uq" UNIQUE("tenant_id","code"),
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" in ('draft', 'issued', 'pending_confirmation', 'partially_paid', 'paid', 'void')),
	CONSTRAINT "invoices_total_amount_check" CHECK ("invoices"."total_amount" >= 0 and "invoices"."total_amount" <= 100000000000),
	CONSTRAINT "invoices_clamped_amount_check" CHECK ("invoices"."clamped_amount" >= 0 and "invoices"."clamped_amount" <= 100000000000),
	CONSTRAINT "invoices_code_check" CHECK ("invoices"."code" ~ '^TH-[0-9A-HJKMNP-TV-Z]{6}$'),
	CONSTRAINT "invoices_transfer_note_check" CHECK ("invoices"."transfer_note" ~ '^TH [0-9A-HJKMNP-TV-Z]{6}$'),
	CONSTRAINT "invoices_qr_payload_check" CHECK (char_length("invoices"."qr_payload") <= 512),
	CONSTRAINT "invoices_installment_check" CHECK (("invoices"."installment_no" is null) = ("invoices"."installment_count" is null)
        and ("invoices"."installment_no" is null or ("invoices"."installment_count" between 1 and 36 and "invoices"."installment_no" between 1 and "invoices"."installment_count"))),
	CONSTRAINT "invoices_issue_fields_check" CHECK (case when "invoices"."status" = 'draft'
        then "invoices"."code" is null and "invoices"."transfer_note" is null and "invoices"."qr_payload" is null and "invoices"."payout" is null and "invoices"."issued_at" is null
        else "invoices"."code" is not null and "invoices"."transfer_note" is not null and "invoices"."qr_payload" is not null and "invoices"."payout" is not null and "invoices"."issued_at" is not null end),
	CONSTRAINT "invoices_void_fields_check" CHECK (("invoices"."status" = 'void') = ("invoices"."voided_at" is not null and "invoices"."void_reason" is not null)
        and ("invoices"."status" = 'void' or ("invoices"."voided_at" is null and "invoices"."void_reason" is null))),
	CONSTRAINT "invoices_void_reason_check" CHECK (char_length("invoices"."void_reason") <= 300)
);
--> statement-breakpoint
CREATE TABLE "payout_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_bin" char(6) NOT NULL,
	"account_no" text NOT NULL,
	"account_name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_accounts_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payout_accounts_bank_bin_check" CHECK ("payout_accounts"."bank_bin" ~ '^[0-9]{6}$'),
	CONSTRAINT "payout_accounts_account_no_check" CHECK ("payout_accounts"."account_no" ~ '^[0-9]{6,19}$'),
	CONSTRAINT "payout_accounts_account_name_check" CHECK (char_length(trim("payout_accounts"."account_name")) between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "fee_type" text;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "fee_amount" bigint;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "fee_rules" jsonb;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "fee_override" jsonb;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_period_fk" FOREIGN KEY ("tenant_id","period_id") REFERENCES "public"."billing_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_replaces_fk" FOREIGN KEY ("tenant_id","replaces_invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_replacement_fk" FOREIGN KEY ("tenant_id","replacement_invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_draft_uq" ON "invoices" USING btree ("tenant_id","period_id","student_id") WHERE "invoices"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_replaces_uq" ON "invoices" USING btree ("replaces_invoice_id") WHERE "invoices"."replaces_invoice_id" is not null;--> statement-breakpoint
CREATE INDEX "invoices_tenant_period_status_idx" ON "invoices" USING btree ("tenant_id","period_id","status");--> statement-breakpoint
CREATE INDEX "invoices_student_id_idx" ON "invoices" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_accounts_primary_uq" ON "payout_accounts" USING btree ("tenant_id") WHERE "payout_accounts"."is_primary";--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_fee_type_check" CHECK ("classes"."fee_type" in ('per_session', 'monthly', 'course'));--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_fee_amount_check" CHECK ("classes"."fee_amount" > 0 and "classes"."fee_amount" <= 100000000000);--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_fee_pair_check" CHECK (("classes"."fee_type" is null) = ("classes"."fee_amount" is null));
--> statement-breakpoint
-- S5-BE-01 + S5-BE-04: học phí lớp, tài khoản nhận tiền, kỳ thu, hóa đơn. RLS + FORCE cho bảng mới theo tenant (nhân sự).
-- Không bật audit trigger của DB cho payout_accounts/invoices: to_jsonb chép số tài khoản vào audit_logs; audit ghi ở tầng ứng dụng.

-- Phụ huynh: các học viên mà user hiện tại là phụ huynh còn hiệu lực. security definer chạy bằng owner (guardians_owner_all, 0023).
create or replace function app_private.linked_student_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select g.student_id from public.guardians g
   where g.user_id = nullif(current_setting('app.user_id', true), '')::uuid
     and g.deleted_at is null;
$$;
--> statement-breakpoint

alter table payout_accounts enable row level security;
--> statement-breakpoint
alter table payout_accounts force row level security;
--> statement-breakpoint
create policy payout_accounts_staff_all on payout_accounts for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create trigger trg_payout_accounts_updated_at before update on payout_accounts
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint

alter table billing_periods enable row level security;
--> statement-breakpoint
alter table billing_periods force row level security;
--> statement-breakpoint
create policy billing_periods_staff_all on billing_periods for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
-- Phụ huynh đọc kỳ (hạn thanh toán, tháng) của hóa đơn không phải nháp của con mình.
create policy billing_periods_parent_read on billing_periods for select to teachhub_app
  using (exists (
    select 1 from invoices i
     where i.tenant_id = billing_periods.tenant_id and i.period_id = billing_periods.id
       and i.status <> 'draft' and i.student_id in (select app_private.linked_student_ids())));
--> statement-breakpoint
create trigger trg_billing_periods_updated_at before update on billing_periods
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint

alter table invoices enable row level security;
--> statement-breakpoint
alter table invoices force row level security;
--> statement-breakpoint
create policy invoices_staff_all on invoices for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy invoices_parent_read on invoices for select to teachhub_app
  using (status <> 'draft' and student_id in (select app_private.linked_student_ids()));
--> statement-breakpoint
create trigger trg_invoices_updated_at before update on invoices
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint

alter table invoice_lines enable row level security;
--> statement-breakpoint
alter table invoice_lines force row level security;
--> statement-breakpoint
create policy invoice_lines_staff_all on invoice_lines for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy invoice_lines_parent_read on invoice_lines for select to teachhub_app
  using (exists (
    select 1 from invoices i
     where i.tenant_id = invoice_lines.tenant_id and i.id = invoice_lines.invoice_id
       and i.status <> 'draft' and i.student_id in (select app_private.linked_student_ids())));
--> statement-breakpoint

-- Bất biến hóa đơn (US-7.3, Spec §4.3). Lỗi mang tiền tố INVOICE_IMMUTABLE để tầng ứng dụng map sang 409.
-- Chạy bằng quyền người gọi (api/worker), không security definer.
create or replace function app_private.invoices_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'INVOICE_IMMUTABLE: hóa đơn chỉ được tạo ở trạng thái draft';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'INVOICE_IMMUTABLE: không xóa hóa đơn đã phát hành';
    end if;
    return old;
  end if;

  if new.tenant_id <> old.tenant_id or new.period_id <> old.period_id or new.student_id <> old.student_id then
    raise exception 'INVOICE_IMMUTABLE: không đổi tenant, kỳ, học viên của hóa đơn';
  end if;
  if new.status <> old.status and not (
       (old.status = 'draft' and new.status = 'issued')
    or (old.status = 'issued' and new.status in ('pending_confirmation', 'partially_paid', 'paid', 'void'))
    or (old.status = 'pending_confirmation' and new.status in ('issued', 'partially_paid', 'paid', 'void'))
    or (old.status = 'partially_paid' and new.status in ('pending_confirmation', 'paid'))
  ) then
    raise exception 'INVOICE_IMMUTABLE: không chuyển trạng thái % -> %', old.status, new.status;
  end if;
  if old.status <> 'draft' and (
       new.total_amount is distinct from old.total_amount
    or new.clamped_amount is distinct from old.clamped_amount
    or new.qr_payload is distinct from old.qr_payload
    or new.payout is distinct from old.payout
    or new.transfer_note is distinct from old.transfer_note
    or new.code is distinct from old.code
    or new.issued_at is distinct from old.issued_at
    or new.installment_no is distinct from old.installment_no
    or new.installment_count is distinct from old.installment_count
    or new.replaces_invoice_id is distinct from old.replaces_invoice_id
  ) then
    raise exception 'INVOICE_IMMUTABLE: hóa đơn đã phát hành không sửa tiền hay snapshot';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger trg_invoices_guard before insert or update or delete on invoices
  for each row execute function app_private.invoices_guard();
--> statement-breakpoint

-- Dòng chỉ ghi được khi hóa đơn còn draft. Khóa dòng hóa đơn (for share) để phát hành đồng thời phải chờ giao dịch ghi dòng.
-- Hóa đơn không còn thấy (xóa cascade từ bản nháp) thì cho qua.
create or replace function app_private.invoice_lines_guard() returns trigger
language plpgsql as $$
declare
  st text;
  inv uuid;
begin
  foreach inv in array case tg_op
    when 'INSERT' then array[new.invoice_id]
    when 'DELETE' then array[old.invoice_id]
    else array(select distinct x from unnest(array[old.invoice_id, new.invoice_id]) x) end
  loop
    select status into st from public.invoices where id = inv for share;
    if st is not null and st <> 'draft' then
      raise exception 'INVOICE_IMMUTABLE: hóa đơn % không còn là bản nháp', inv;
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
--> statement-breakpoint
create trigger trg_invoice_lines_guard before insert or update or delete on invoice_lines
  for each row execute function app_private.invoice_lines_guard();
