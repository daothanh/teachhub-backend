-- Một mã giao dịch ngân hàng chỉ xác nhận được một đơn; admin_confirm_bank_transfer chặn chuyển khoản chồng lên kỳ của store và ghi audit kèm request id, IP nguồn.
CREATE UNIQUE INDEX "bank_transfer_orders_ref_uq" ON "bank_transfer_orders" USING btree ("bank_transaction_ref") WHERE "bank_transfer_orders"."bank_transaction_ref" is not null;
--> statement-breakpoint
-- Xác nhận đơn (thay bản 0031: thêm mã giao dịch duy nhất, chặn kỳ của store, audit kèm request id và IP): khóa đơn rồi subscription của tenant; một giao dịch với đổi trạng thái đơn, kích hoạt Pro và sự kiện outbox.
-- Kỳ 12 tháng (giá Pro là giá một năm). Đang Pro còn hạn (active/trialing) thì cộng nối từ hạn hiện tại, không rút ngắn; ngược lại tính từ bây giờ.
-- Trả jsonb {result: not_found | stale | amount_mismatch | ok | replay, ...}. `replay` = đơn đã được chính admin này xác nhận với đúng
-- mã giao dịch và số tiền (gọi lại sau lỗi mạng): trả lại kết quả cũ, không cộng kỳ lần hai. Mọi trường hợp khác trên đơn đã `confirmed` là `stale`.
create or replace function app_private.admin_confirm_bank_transfer(
  p_order_id uuid, p_amount bigint, p_ref text, p_expected timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  admin_id text := nullif(current_setting('app.admin_user', true), '');
  o public.bank_transfer_orders; s public.subscriptions; tname text; res text := 'ok'; base timestamptz;
  req_id text := nullif(current_setting('app.admin_request_id', true), ''); req_ip text := nullif(current_setting('app.admin_ip', true), '');
begin
  if coalesce(current_setting('app.admin', true), '') <> '1' or admin_id is null then
    raise exception 'admin_confirm_bank_transfer: chỉ gọi từ đường admin' using errcode = '42501';
  end if;
  select * into o from public.bank_transfer_orders where id = p_order_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  select * into s from public.subscriptions where tenant_id = o.tenant_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;

  if o.status = 'confirmed' then
    if o.confirmed_by is distinct from admin_id or o.bank_transaction_ref is distinct from p_ref or o.amount <> p_amount then
      return jsonb_build_object('result', 'stale');
    end if;
    res := 'replay';
  else
    if date_trunc('milliseconds', o.updated_at) <> p_expected then return jsonb_build_object('result', 'stale'); end if;
    if o.amount <> p_amount then return jsonb_build_object('result', 'amount_mismatch'); end if;
    if exists (select 1 from public.bank_transfer_orders where bank_transaction_ref = p_ref and id <> o.id) then
      return jsonb_build_object('result', 'ref_used');
    end if;
    -- Pro đang trả bằng App Store/Google Play còn hạn: không cộng nối chồng lên (store vẫn thu tiền), không đổi nguồn.
    if s.status = 'active' and s.source in ('app_store', 'play_store') and s.current_period_end > now() then
      return jsonb_build_object('result', 'store_managed');
    end if;
    base := case when s.status in ('trialing', 'active') and s.current_period_end > now() then s.current_period_end else now() end;
    begin
      update public.bank_transfer_orders
         set status = 'confirmed', bank_transaction_ref = p_ref, confirmed_by = admin_id, confirmed_at = now()
       where id = o.id returning * into o;
    exception when unique_violation then
      -- Đơn khác vừa dùng cùng mã giao dịch (đua giữa hai đơn): chỉ khối này được hoàn tác.
      return jsonb_build_object('result', 'ref_used');
    end;
    perform app_private.audit_insert(o.tenant_id, 'bank_transfer_order_confirm', o.id, 'update', null,
      jsonb_build_object('confirmed_by', admin_id, 'request_id', req_id, 'ip', req_ip, 'bank_transaction_ref', p_ref, 'amount', o.amount));
    update public.subscriptions
       set plan_code = 'pro', status = 'active', source = 'bank_transfer',
           current_period_end = base + interval '12 months', external_ref = 'bank_transfer:' || o.id::text
     where id = s.id returning * into s;
    insert into public.outbox_events (id, tenant_id, type, payload)
      values (gen_random_uuid(), o.tenant_id, 'subscription_activated',
              jsonb_build_object('source', 'bank_transfer', 'currentPeriodEnd', to_char(s.current_period_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  end if;

  select name into tname from public.tenants where id = o.tenant_id;
  return jsonb_build_object('result', res,
    'order', jsonb_build_object(
      'id', o.id, 'tenantId', o.tenant_id, 'tenantName', tname, 'amount', o.amount, 'transferNote', o.transfer_note,
      'status', o.status, 'createdAtMs', floor(extract(epoch from o.created_at) * 1000),
      'confirmedBy', o.confirmed_by, 'confirmedAtMs', floor(extract(epoch from o.confirmed_at) * 1000),
      'bankTransactionRef', o.bank_transaction_ref, 'updatedAtMs', floor(extract(epoch from o.updated_at) * 1000)),
    'subscription', jsonb_build_object('planCode', s.plan_code, 'status', s.status,
      'currentPeriodEndMs', floor(extract(epoch from s.current_period_end) * 1000)));
end;
$$;
