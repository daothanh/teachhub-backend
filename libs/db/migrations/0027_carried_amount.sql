ALTER TABLE "invoices" ADD COLUMN "carried_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_carried_amount_check" CHECK ("invoices"."carried_amount" >= 0 and "invoices"."carried_amount" <= "invoices"."total_amount");--> statement-breakpoint
-- S6-BE-03: nợ chuyển kỳ qua sổ học viên. `invoices.carried_amount` là phần còn nợ của hóa đơn đã kết chuyển sang hóa đơn kỳ sau
-- (công nợ chỉ tính ở hóa đơn kỳ sau, không tính hai lần). Luôn = Σ(debit − credit) các dòng `unpaid_carried` của hóa đơn,
-- kiểm cuối giao dịch để job và service ghi sổ/cập nhật hóa đơn theo thứ tự tùy ý. `invoices_guard` không khóa cột này nên đổi được sau phát hành.
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
create constraint trigger trg_student_ledger_carried_matches after insert on student_ledger
  deferrable initially deferred for each row
  when (new.kind = 'unpaid_carried')
  execute function app_private.invoice_carried_matches();
--> statement-breakpoint
-- `unpaid_carried` chỉ ghi nợ cho một hóa đơn đã phát hành (không nháp/hủy) của đúng học viên cùng tenant; dòng `applied_to_invoice`
-- gắn hóa đơn nhận khoản chuyển kỳ (cùng tenant, đúng học viên). Guard 0026 giữ nguyên cho hai kind thanh toán.
create or replace function app_private.student_ledger_guard() returns trigger
language plpgsql set search_path = '' as $$
declare p public.payments; inv public.invoices; net bigint; cap bigint;
begin
  if new.kind in ('unpaid_carried', 'applied_to_invoice') then
    select * into inv from public.invoices where tenant_id = new.tenant_id and id = new.invoice_id;
    if inv.id is null or inv.student_id <> new.student_id or new.payment_id is not null
       or (new.kind = 'unpaid_carried' and (inv.status in ('draft', 'void') or new.debit <= 0)) then
      raise exception 'LEDGER_INVALID: % cần hóa đơn đúng học viên cùng tenant (unpaid_carried: đã phát hành, ghi nợ)', new.kind using errcode = '23514';
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
