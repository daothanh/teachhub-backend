ALTER TABLE "invoices" DROP CONSTRAINT "invoices_issue_fields_check";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "carried_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "oldest_due_date" date;--> statement-breakpoint
CREATE INDEX "invoices_debt_idx" ON "invoices" USING btree ("tenant_id","student_id") WHERE "invoices"."status" in ('issued', 'partially_paid', 'pending_confirmation');--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_carried_amount_check" CHECK ("invoices"."carried_amount" >= 0 and "invoices"."carried_amount" <= "invoices"."total_amount"
        and ("invoices"."carried_amount" = 0 or "invoices"."paid_amount" + "invoices"."carried_amount" <= "invoices"."total_amount")
        and ("invoices"."status" <> 'draft' or "invoices"."carried_amount" = 0));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issue_fields_check" CHECK (case when "invoices"."status" = 'draft'
        then "invoices"."code" is null and "invoices"."transfer_note" is null and "invoices"."qr_payload" is null and "invoices"."payout" is null and "invoices"."issued_at" is null
        else "invoices"."code" is not null and "invoices"."transfer_note" is not null and ("invoices"."qr_payload" is not null or "invoices"."total_amount" = 0) and "invoices"."payout" is not null and "invoices"."issued_at" is not null end);
--> statement-breakpoint
-- S6-BE-03: nợ chuyển kỳ qua sổ học viên, kết chuyển lúc PHÁT HÀNH. `invoices.carried_amount` là phần còn nợ của hóa đơn đã kết
-- chuyển sang hóa đơn kỳ sau (công nợ chỉ tính ở hóa đơn sau, không tính hai lần); luôn = Σ(debit − credit) các dòng `unpaid_carried`
-- của hóa đơn, kiểm cuối giao dịch. `oldest_due_date` = hạn cũ nhất của các khoản nợ được chuyển vào hóa đơn (tuổi nợ T11).
-- Dữ liệu `unpaid_carried` có từ trước migration này sẽ không khớp carried_amount = 0: dừng thay vì đoán. Vai trò chạy migration bị
-- FORCE RLS và không có policy trên student_ledger nên mở policy đọc tạm trong chính giao dịch migration rồi bỏ.
CREATE POLICY migration_0027_owner_read ON student_ledger FOR SELECT TO teachhub_owner USING (true);
--> statement-breakpoint
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.student_ledger WHERE kind = 'unpaid_carried';
  IF n > 0 THEN
    RAISE EXCEPTION 'Migration 0027: có % dòng unpaid_carried từ trước; carried_amount của hóa đơn tương ứng phải được đặt tay rồi chạy lại.', n;
  END IF;
END $$;
--> statement-breakpoint
DROP POLICY migration_0027_owner_read ON student_ledger;
--> statement-breakpoint
create or replace function app_private.invoice_carried_matches() returns trigger
language plpgsql set search_path = '' as $$
declare inv uuid; carried bigint; ledger bigint;
begin
  if tg_table_name = 'invoices' then inv := new.id; else inv := new.invoice_id; end if;
  select i.carried_amount into carried from public.invoices i where i.tenant_id = new.tenant_id and i.id = inv;
  if not found then
    raise exception 'INVOICE_CARRIED_MISMATCH: không đọc được hóa đơn %', inv using errcode = '23514';
  end if;
  select coalesce(sum(l.debit - l.credit), 0) into ledger from public.student_ledger l
   where l.tenant_id = new.tenant_id and l.invoice_id = inv and l.kind = 'unpaid_carried';
  if carried <> ledger then
    raise exception 'INVOICE_CARRIED_MISMATCH: hóa đơn % có carried_amount % khác sổ unpaid_carried %', inv, carried, ledger
      using errcode = '23514';
  end if;
  return null;
end;
$$;
--> statement-breakpoint
create constraint trigger trg_invoices_carried_matches after update on invoices
  deferrable initially deferred for each row
  when (old.carried_amount is distinct from new.carried_amount)
  execute function app_private.invoice_carried_matches();
--> statement-breakpoint
create constraint trigger trg_invoices_carried_matches_ins after insert on invoices
  deferrable initially deferred for each row
  when (new.carried_amount <> 0)
  execute function app_private.invoice_carried_matches();
--> statement-breakpoint
create constraint trigger trg_student_ledger_carried_matches after insert on student_ledger
  deferrable initially deferred for each row
  when (new.kind = 'unpaid_carried')
  execute function app_private.invoice_carried_matches();
--> statement-breakpoint
-- `unpaid_carried`: ghi nợ cho hóa đơn đã phát hành (không nháp/hủy) của đúng học viên cùng tenant. `applied_to_invoice`: gắn hóa
-- đơn nhận khoản chuyển kỳ (cùng tenant, đúng học viên, không hủy); dấu do student_ledger_amount_check (đúng một vế khác 0).
-- Guard 0026 giữ nguyên cho hai kind thanh toán.
create or replace function app_private.student_ledger_guard() returns trigger
language plpgsql set search_path = '' as $$
declare p public.payments; inv public.invoices; net bigint; cap bigint;
begin
  if new.kind in ('unpaid_carried', 'applied_to_invoice') then
    select * into inv from public.invoices where tenant_id = new.tenant_id and id = new.invoice_id;
    if inv.id is null or inv.student_id <> new.student_id or new.payment_id is not null or inv.status = 'void'
       or (new.kind = 'unpaid_carried' and (inv.status = 'draft' or new.debit <= 0)) then
      raise exception 'LEDGER_INVALID: % cần hóa đơn không hủy đúng học viên cùng tenant (unpaid_carried: đã phát hành, ghi nợ)', new.kind using errcode = '23514';
    end if;
    return new;
  end if;
  if new.kind not in ('overpayment', 'payment_void') then
    return new;
  end if;
  if new.payment_id is null or new.invoice_id is null then
    raise exception 'LEDGER_INVALID: % cần payment_id và invoice_id', new.kind using errcode = '23514';
  end if;
  select * into p from public.payments where tenant_id = new.tenant_id and id = new.payment_id;
  select * into inv from public.invoices where tenant_id = new.tenant_id and id = new.invoice_id;
  if p.id is null or inv.id is null or p.invoice_id <> inv.id or inv.student_id <> new.student_id then
    raise exception 'LEDGER_INVALID: % không khớp thanh toán/hóa đơn/học viên cùng tenant', new.kind using errcode = '23514';
  end if;
  select coalesce(sum(l.credit - l.debit), 0) into net from public.student_ledger l
   where l.tenant_id = new.tenant_id and l.invoice_id = inv.id and l.kind in ('overpayment', 'payment_void');
  if new.kind = 'overpayment' then
    select greatest(coalesce(sum(x.amount), 0) - inv.total_amount, 0) into cap from public.payments x
     where x.tenant_id = inv.tenant_id and x.invoice_id = inv.id and x.voided_at is null;
    if new.debit <> 0 or new.credit > p.amount or p.voided_at is not null or new.credit > cap or net + new.credit > cap then
      raise exception 'LEDGER_INVALID: trả thừa phải ghi có, ≤ số tiền thanh toán chưa hủy và ≤ phần vượt thật của hóa đơn' using errcode = '23514';
    end if;
  elsif new.credit <> 0 or new.debit > p.amount or p.voided_at is null or new.debit > net then
    raise exception 'LEDGER_INVALID: đảo trả thừa phải ghi nợ, thanh toán đã hủy, ≤ số tiền thanh toán và ≤ phần trả thừa còn lại của hóa đơn' using errcode = '23514';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
-- Bất biến hóa đơn (thay 0026): thêm chặn hủy hóa đơn đã chuyển nợ/mang dòng carry_over ≠ 0 và khóa `oldest_due_date` sau phát hành.
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
  -- S6-BE-03: hóa đơn đã chuyển nợ sang kỳ sau, hoặc mang số dư chuyển kỳ (dòng carry_over ≠ 0), không hủy được (hủy làm mất nợ).
  if new.status = 'void' and old.status <> 'void' and (
       old.carried_amount > 0
    or exists (select 1 from public.invoice_lines l
                where l.tenant_id = old.tenant_id and l.invoice_id = old.id and l.kind = 'carry_over' and l.amount <> 0)
  ) then
    raise exception 'INVOICE_IMMUTABLE: hóa đơn đã chuyển nợ hoặc mang số dư chuyển kỳ không hủy được';
  end if;
  if old.status <> 'draft' and new.oldest_due_date is distinct from old.oldest_due_date then
    raise exception 'INVOICE_IMMUTABLE: hạn nợ cũ nhất đã phát hành không sửa';
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
