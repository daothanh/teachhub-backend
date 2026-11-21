CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"method" text NOT NULL,
	"paid_on" date NOT NULL,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"voided_by" uuid,
	CONSTRAINT "payments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount" > 0 and "payments"."amount" <= 100000000000),
	CONSTRAINT "payments_method_check" CHECK ("payments"."method" in ('bank_transfer', 'cash')),
	CONSTRAINT "payments_note_check" CHECK (char_length("payments"."note") <= 300),
	CONSTRAINT "payments_void_fields_check" CHECK (("payments"."voided_at" is null) = ("payments"."void_reason" is null) and ("payments"."voided_at" is null) = ("payments"."voided_by" is null)
        and ("payments"."void_reason" is null or char_length("payments"."void_reason") between 1 and 300))
);
--> statement-breakpoint
CREATE TABLE "revenue_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"entry_date" date NOT NULL,
	"fiscal_year" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_ledger_payment_kind_uq" UNIQUE("payment_id","kind"),
	CONSTRAINT "revenue_ledger_kind_check" CHECK ("revenue_ledger"."kind" in ('payment', 'reversal')),
	CONSTRAINT "revenue_ledger_amount_check" CHECK (case "revenue_ledger"."kind" when 'payment' then "revenue_ledger"."amount" between 1 and 100000000000 else "revenue_ledger"."amount" between -100000000000 and -1 end),
	CONSTRAINT "revenue_ledger_year_check" CHECK ("revenue_ledger"."fiscal_year" = extract(year from "revenue_ledger"."entry_date")::int)
);
--> statement-breakpoint
CREATE TABLE "student_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"invoice_id" uuid,
	"payment_id" uuid,
	"kind" text NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_ledger_kind_check" CHECK ("student_ledger"."kind" in ('unpaid_carried', 'overpayment', 'prev_adjustment', 'applied_to_invoice', 'payment_void')),
	CONSTRAINT "student_ledger_amount_check" CHECK ("student_ledger"."debit" between 0 and 100000000000 and "student_ledger"."credit" between 0 and 100000000000 and ("student_ledger"."debit" > 0) <> ("student_ledger"."credit" > 0))
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_ledger" ADD CONSTRAINT "revenue_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_ledger" ADD CONSTRAINT "revenue_ledger_tenant_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_ledger" ADD CONSTRAINT "student_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_ledger" ADD CONSTRAINT "student_ledger_tenant_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_ledger" ADD CONSTRAINT "student_ledger_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_ledger" ADD CONSTRAINT "student_ledger_tenant_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_tenant_paid_on_idx" ON "payments" USING btree ("tenant_id","paid_on");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("tenant_id","invoice_id","recorded_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_recorded_by_idx" ON "payments" USING btree ("recorded_by");--> statement-breakpoint
CREATE INDEX "payments_voided_by_idx" ON "payments" USING btree ("voided_by") WHERE "payments"."voided_by" is not null;--> statement-breakpoint
CREATE INDEX "revenue_ledger_year_idx" ON "revenue_ledger" USING btree ("tenant_id","fiscal_year","entry_date");--> statement-breakpoint
CREATE INDEX "student_ledger_student_idx" ON "student_ledger" USING btree ("tenant_id","student_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "student_ledger_invoice_idx" ON "student_ledger" USING btree ("tenant_id","invoice_id") WHERE "student_ledger"."invoice_id" is not null;--> statement-breakpoint
CREATE INDEX "student_ledger_payment_idx" ON "student_ledger" USING btree ("tenant_id","payment_id") WHERE "student_ledger"."payment_id" is not null;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_amount_check" CHECK ("invoices"."paid_amount" >= 0 and "invoices"."paid_amount" <= 100000000000);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_status_check" CHECK (case "invoices"."status"
        when 'partially_paid' then "invoices"."paid_amount" > 0 and "invoices"."paid_amount" < "invoices"."total_amount"
        when 'paid' then "invoices"."paid_amount" >= "invoices"."total_amount"
        when 'pending_confirmation' then true
        else "invoices"."paid_amount" = 0 end);
--> statement-breakpoint
-- S6-BE-01: thanh toán, sổ học viên, sổ doanh thu. RLS + FORCE cho cả ba bảng; phụ huynh chỉ đọc `payments` của hóa đơn
-- đã phát hành của con đã liên kết (biên nhận), không có quyền gì với hai sổ.

alter table payments enable row level security;
--> statement-breakpoint
alter table payments force row level security;
--> statement-breakpoint
create policy payments_staff_all on payments for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy payments_parent_read on payments for select to teachhub_app
  using (exists (
    select 1 from invoices i
     where i.tenant_id = payments.tenant_id and i.id = payments.invoice_id
       and i.status <> 'draft' and i.student_id in (select app_private.linked_student_ids())));
--> statement-breakpoint

alter table student_ledger enable row level security;
--> statement-breakpoint
alter table student_ledger force row level security;
--> statement-breakpoint
create policy student_ledger_staff_read on student_ledger for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy student_ledger_staff_insert on student_ledger for insert to teachhub_app
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint

alter table revenue_ledger enable row level security;
--> statement-breakpoint
alter table revenue_ledger force row level security;
--> statement-breakpoint
create policy revenue_ledger_staff_read on revenue_ledger for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy revenue_ledger_staff_insert on revenue_ledger for insert to teachhub_app
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint

-- Chỉ ghi thêm: thu quyền ở mức bảng và trigger chặn cả vai trò BYPASSRLS/owner (chứng từ tài chính, giữ 5 năm).
revoke update, delete, truncate on student_ledger, revenue_ledger from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint
revoke delete, truncate on payments from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint
create or replace function app_private.ledger_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'LEDGER_APPEND_ONLY: % chỉ ghi thêm, không cho phép %', tg_table_name, tg_op using errcode = '42501';
end;
$$;
--> statement-breakpoint
create trigger trg_student_ledger_append_only before update or delete on student_ledger
  for each row execute function app_private.ledger_append_only();
--> statement-breakpoint
create trigger trg_student_ledger_no_truncate before truncate on student_ledger
  for each statement execute function app_private.ledger_append_only();
--> statement-breakpoint
create trigger trg_revenue_ledger_append_only before update or delete on revenue_ledger
  for each row execute function app_private.ledger_append_only();
--> statement-breakpoint
create trigger trg_revenue_ledger_no_truncate before truncate on revenue_ledger
  for each statement execute function app_private.ledger_append_only();
--> statement-breakpoint

-- Thanh toán: không xóa; chỉ được đặt `voided_*` MỘT lần (lý do và người hủy đầu tiên là chứng từ), mọi cột khác bất biến.
create or replace function app_private.payments_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.voided_at is not null then
      raise exception 'PAYMENT_IMMUTABLE: thanh toán chỉ được tạo ở trạng thái chưa hủy' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'PAYMENT_IMMUTABLE: không xóa thanh toán, hãy hủy có lý do' using errcode = '42501';
  end if;
  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.invoice_id <> old.invoice_id
     or new.amount <> old.amount or new.method <> old.method or new.paid_on <> old.paid_on
     or new.note is distinct from old.note or new.recorded_by <> old.recorded_by or new.recorded_at <> old.recorded_at then
    raise exception 'PAYMENT_IMMUTABLE: thanh toán không sửa, chỉ hủy' using errcode = '42501';
  end if;
  if old.voided_at is not null and (
       new.voided_at is distinct from old.voided_at
    or new.void_reason is distinct from old.void_reason
    or new.voided_by is distinct from old.voided_by
  ) then
    raise exception 'PAYMENT_IMMUTABLE: thanh toán đã hủy, không sửa lý do hay người hủy' using errcode = '42501';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger trg_payments_guard before insert or update or delete on payments
  for each row execute function app_private.payments_guard();
--> statement-breakpoint
create trigger trg_payments_no_truncate before truncate on payments
  for each statement execute function app_private.payments_guard();
--> statement-breakpoint

-- Bất biến hóa đơn (thay 0024, giữ mọi bảo vệ khác): thêm chuyển trạng thái khi ghi/hủy thanh toán
-- (partially_paid -> issued, paid -> partially_paid/issued). Tiền và snapshot vẫn không đổi được; `paid_amount` đổi tự do
-- (bị `invoices_paid_status_check` khóa theo trạng thái).
create or replace function app_private.invoices_guard() returns trigger
language plpgsql set search_path = '' as $$
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
    or (old.status = 'pending_confirmation' and new.status in ('issued', 'partially_paid', 'paid'))
    or (old.status = 'partially_paid' and new.status in ('issued', 'pending_confirmation', 'paid'))
    or (old.status = 'paid' and new.status in ('issued', 'partially_paid'))
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
  -- Lý do hủy, giờ hủy và hóa đơn thay thế là chứng từ: đã ghi thì không đổi.
  if old.status = 'void' and (
       new.void_reason is distinct from old.void_reason
    or new.voided_at is distinct from old.voided_at
  ) then
    raise exception 'INVOICE_IMMUTABLE: hóa đơn đã hủy không sửa lý do hay giờ hủy';
  end if;
  if old.replacement_invoice_id is not null and new.replacement_invoice_id is distinct from old.replacement_invoice_id then
    raise exception 'INVOICE_IMMUTABLE: hóa đơn thay thế đã gán, không đổi';
  end if;
  return new;
end;
$$;
--> statement-breakpoint

-- Tên hiển thị của người ghi/hủy thanh toán: `users` chỉ cho đọc dòng của chính mình (users_self) nên đi qua hàm security
-- definer, chỉ cho nhân sự của tenant và chỉ trả user có membership ở tenant đó. `deleted` = tài khoản đã xóa (ẩn danh).
create or replace function app_private.tenant_user_names(p_tenant_id uuid, p_ids uuid[])
returns table (user_id uuid, display_name text, deleted boolean)
language sql stable security definer set search_path = '' as $$
  select u.id, u.display_name, u.deleted_at is not null
    from public.users u
   where u.id = any(p_ids)
     and p_tenant_id in (select app_private.staff_tenant_ids())
     and exists (select 1 from public.memberships m where m.tenant_id = p_tenant_id and m.user_id = u.id);
$$;
--> statement-breakpoint
revoke execute on function app_private.tenant_user_names(uuid, uuid[]) from teachhub_worker, teachhub_readonly, public;
