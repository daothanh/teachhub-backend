-- S7-BE admin: xác nhận chuyển khoản gói Pro (US-0.8 AC3). Admin (BFF) không có user/tenant nên đi qua hàm security definer;
-- hàm chỉ chạy trong giao dịch có cờ `app.admin = '1'` và `app.admin_user` (id IAM, không rỗng) do AdminService đặt sau khi
-- AdminGuard đã kiểm secret + quyền. Giới hạn: cờ do chính role app đặt nên chặn gọi nhầm, không thay cho kiểm soát SQL injection.
-- Audit: trigger audit của `bank_transfer_orders` và `subscriptions` ghi audit_logs (actor trống; người xác nhận nằm ở `confirmed_by` trong after_data).

-- Sự kiện outbox "Pro đã kích hoạt" ghi từ hàm (chạy bằng owner): thêm policy INSERT cho owner.
create policy outbox_events_owner_insert on outbox_events for insert to teachhub_owner with check (true);
--> statement-breakpoint

create or replace function app_private.admin_list_bank_transfer_orders(p_status text, p_limit int, p_offset int) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('app.admin', true), '') <> '1' or coalesce(current_setting('app.admin_user', true), '') = '' then
    raise exception 'admin_list_bank_transfer_orders: chỉ gọi từ đường admin' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'total', (select count(*) from public.bank_transfer_orders where status = p_status),
    'items', coalesce((
      select jsonb_agg(x.o order by x.created_at, x.id) from (
        select b.id, b.created_at, jsonb_build_object(
          'id', b.id, 'tenantId', b.tenant_id, 'tenantName', t.name, 'amount', b.amount, 'transferNote', b.transfer_note,
          'status', b.status, 'createdAtMs', floor(extract(epoch from b.created_at) * 1000),
          'confirmedBy', b.confirmed_by, 'confirmedAtMs', floor(extract(epoch from b.confirmed_at) * 1000),
          'bankTransactionRef', b.bank_transaction_ref, 'updatedAtMs', floor(extract(epoch from b.updated_at) * 1000)) as o
        from public.bank_transfer_orders b join public.tenants t on t.id = b.tenant_id
        where b.status = p_status order by b.created_at, b.id limit p_limit offset p_offset
      ) x), '[]'::jsonb));
end;
$$;
--> statement-breakpoint

-- Xác nhận đơn: khóa đơn rồi subscription của tenant; một giao dịch với đổi trạng thái đơn, kích hoạt Pro và sự kiện outbox.
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
    base := case when s.status in ('trialing', 'active') and s.current_period_end > now() then s.current_period_end else now() end;
    update public.bank_transfer_orders
       set status = 'confirmed', bank_transaction_ref = p_ref, confirmed_by = admin_id, confirmed_at = now()
     where id = o.id returning * into o;
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
--> statement-breakpoint
revoke execute on function app_private.admin_list_bank_transfer_orders(text, int, int),
  app_private.admin_confirm_bank_transfer(uuid, bigint, text, timestamptz)
  from teachhub_worker, teachhub_readonly, public;
