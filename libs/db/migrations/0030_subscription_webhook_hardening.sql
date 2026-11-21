-- Gia cố webhook RevenueCat (review bảo mật S7): hàm đổi gói chỉ chạy trong giao dịch của đường webhook (cờ phiên
-- `app.webhook = '1'` do RevenueCatService đặt bằng set_config(..., true)) nên route/SQL khác không gọi tùy ý được;
-- sự kiện đã `ignored` được xử lý lại khi RevenueCat gửi lại, chỉ `processed` mới là `duplicate`.
-- Giới hạn: cờ do chính role app đặt nên chỉ chặn gọi nhầm/bỏ sót, không thay cho kiểm soát SQL injection.
create or replace function app_private.rc_begin_event(
  p_event_id text, p_tenant_id uuid, p_type text, p_event_at timestamptz, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; ev public.subscription_events; last_at timestamptz;
begin
  if coalesce(current_setting('app.webhook', true), '') <> '1' then
    raise exception 'rc_begin_event: chỉ gọi từ đường webhook' using errcode = '42501';
  end if;
  select * into s from public.subscriptions where tenant_id = p_tenant_id for update;
  if not found then return jsonb_build_object('result', 'unknown_tenant'); end if;
  insert into public.subscription_events (id, tenant_id, source, event_id, type, outcome, event_at, payload)
    values (gen_random_uuid(), p_tenant_id, 'revenuecat', p_event_id, p_type, 'ignored', p_event_at, p_payload)
    on conflict (source, event_id) do nothing;
  select * into ev from public.subscription_events where source = 'revenuecat' and event_id = p_event_id;
  -- Đã áp dụng, hoặc id này thuộc tenant khác: không làm lại.
  if ev.outcome = 'processed' or ev.tenant_id <> p_tenant_id then
    return jsonb_build_object('result', 'duplicate');
  end if;
  update public.subscription_events set type = p_type, event_at = p_event_at, payload = p_payload where id = ev.id;
  select max(event_at) into last_at from public.subscription_events
   where tenant_id = p_tenant_id and source = 'revenuecat' and outcome = 'processed';
  return jsonb_build_object('result', 'ok', 'status', s.status, 'source', s.source,
    'currentPeriodEnd', s.current_period_end, 'externalRef', s.external_ref, 'lastAppliedAt', last_at);
end;
$$;
--> statement-breakpoint
create or replace function app_private.rc_apply_event(
  p_event_id text, p_tenant_id uuid, p_plan_code text, p_status text, p_source text,
  p_period_end timestamptz, p_external_ref text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('app.webhook', true), '') <> '1' then
    raise exception 'rc_apply_event: chỉ gọi từ đường webhook' using errcode = '42501';
  end if;
  -- Trigger audit của `subscriptions` ghi audit_logs (actor trống vì webhook không có user).
  update public.subscriptions
     set plan_code = p_plan_code, status = p_status, source = p_source,
         current_period_end = p_period_end, external_ref = p_external_ref
   where tenant_id = p_tenant_id;
  update public.subscription_events set outcome = 'processed'
   where source = 'revenuecat' and event_id = p_event_id and tenant_id = p_tenant_id;
end;
$$;
