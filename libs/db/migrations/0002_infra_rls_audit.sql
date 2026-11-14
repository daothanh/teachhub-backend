-- RLS cho bảng hạ tầng + audit_logs phân vùng tháng + trigger audit tổng quát (Mục 4.4, 4.8, 6.3; ADR-TH-BE-001).

-- idempotency_keys: api chỉ thấy khóa của chính user (app.user_id đặt bởi TxService).
alter table idempotency_keys enable row level security;
--> statement-breakpoint
alter table idempotency_keys force row level security;
--> statement-breakpoint
create policy idempotency_keys_app_own on idempotency_keys for all to teachhub_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

-- job_runs: chỉ worker (BYPASSRLS) ghi/đọc; api không có policy → 0 dòng.
alter table job_runs enable row level security;
--> statement-breakpoint
alter table job_runs force row level security;
--> statement-breakpoint

-- audit_logs: chỉ ghi thêm, phân vùng theo tháng, không có phân vùng default (lỗi lộ sớm).
create table audit_logs (
  id bigint generated always as identity,
  tenant_id uuid,
  actor_user_id uuid,
  entity text not null,
  entity_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);
--> statement-breakpoint
create index audit_logs_tenant_entity_idx on audit_logs (tenant_id, entity, entity_id, created_at);
--> statement-breakpoint
alter table audit_logs enable row level security;
--> statement-breakpoint
alter table audit_logs force row level security;
--> statement-breakpoint
-- Ghi chỉ qua app_private.audit_insert (security definer, chạy bằng teachhub_owner).
-- Policy đọc cho nhân sự tenant thêm ở Sprint 1 khi có memberships/staff_tenant_ids().
create policy audit_logs_owner_insert on audit_logs for insert to teachhub_owner with check (true);
--> statement-breakpoint
revoke insert, update, delete on audit_logs from teachhub_app, teachhub_worker;
--> statement-breakpoint

-- Tạo phân vùng tháng (UTC) chứa `p_at` nếu chưa có. Phân vùng cũng bật + ép RLS (không policy) để không ai
-- đọc thẳng phân vùng mà né policy của bảng cha.
create or replace function app_private.ensure_audit_partition(p_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare
  month_start date := date_trunc('month', p_at at time zone 'UTC')::date;
  part text := format('audit_logs_y%sm%s', to_char(month_start, 'YYYY'), to_char(month_start, 'MM'));
begin
  if to_regclass('public.' || part) is not null then
    return;
  end if;
  begin
    execute format(
      'create table public.%I partition of public.audit_logs for values from (%L) to (%L)',
      part, month_start::timestamp at time zone 'UTC', (month_start + interval '1 month')::timestamp at time zone 'UTC'
    );
  exception when duplicate_table then
    return; -- giao dịch khác vừa tạo
  end;
  execute format('alter table public.%I enable row level security', part);
  execute format('alter table public.%I force row level security', part);
  execute format('revoke all on public.%I from teachhub_app, teachhub_worker, teachhub_readonly', part);
end;
$$;
--> statement-breakpoint

-- Điểm ghi audit duy nhất (trigger và sau này AdminGuard của api). Actor lấy từ app.user_id.
create or replace function app_private.audit_insert(
  p_tenant_id uuid, p_entity text, p_entity_id uuid, p_action text, p_before jsonb, p_after jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.ensure_audit_partition(now());
  insert into public.audit_logs (tenant_id, actor_user_id, entity, entity_id, action, before_data, after_data)
  values (
    p_tenant_id,
    nullif(current_setting('app.user_id', true), '')::uuid,
    p_entity, p_entity_id, p_action, p_before, p_after
  );
end;
$$;
--> statement-breakpoint

-- Trigger tổng quát: gắn bằng app_private.enable_audit('<bảng>'). Bỏ phone/email khỏi before/after (Mục 4.8);
-- bỏ qua UPDATE không đổi gì.
create or replace function app_private.audit_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - 'phone' - 'email' end;
  new_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - 'phone' - 'email' end;
  row_data jsonb := coalesce(new_row, old_row);
begin
  if tg_op = 'UPDATE' and old_row = new_row then
    return null;
  end if;
  perform app_private.audit_insert(
    (row_data ->> 'tenant_id')::uuid,
    tg_table_name,
    (row_data ->> 'id')::uuid,
    lower(tg_op),
    old_row,
    new_row
  );
  return null;
end;
$$;
--> statement-breakpoint

create or replace function app_private.enable_audit(tbl regclass) returns void
language plpgsql set search_path = '' as $$
begin
  execute format(
    'create trigger %I after insert or update or delete on %s for each row execute function app_private.audit_trigger()',
    'trg_' || (select relname from pg_class where oid = tbl) || '_audit', tbl
  );
end;
$$;
--> statement-breakpoint

-- Hàm nội bộ: không cho api/worker gọi trực tiếp (trigger chạy với quyền của owner hàm).
revoke execute on function app_private.ensure_audit_partition(timestamptz), app_private.enable_audit(regclass)
  from teachhub_app, teachhub_worker, teachhub_readonly, public;
--> statement-breakpoint
revoke execute on function app_private.audit_insert(uuid, text, uuid, text, jsonb, jsonb)
  from teachhub_readonly, public;
--> statement-breakpoint

select app_private.ensure_audit_partition(now());
--> statement-breakpoint
select app_private.ensure_audit_partition(now() + interval '1 month');
