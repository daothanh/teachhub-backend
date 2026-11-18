-- POST /v1/workspaces (S1-BE-08, US-0.10 AC2): tenant giáo viên + chi nhánh mặc định + chủ tenant + gói Free
-- trong một giao dịch. Lúc tạo, user chưa là nhân sự nên policy theo staff_tenant_ids() chặn → hàm security
-- definer. User lấy từ app.user_id (không nhận từ tham số): không tạo được không gian đứng tên người khác.

create policy tenants_owner_all on tenants for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy branches_owner_all on branches for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy subscriptions_owner_all on subscriptions for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
drop policy memberships_owner_read on memberships;
--> statement-breakpoint
create policy memberships_owner_all on memberships for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint

-- created = false: user đã có không gian Giáo viên → trả cái sẵn có (US-0.1 AC4: không tạo tenant mới).
create or replace function app_private.create_teacher_workspace(
  p_tenant_id uuid, p_branch_id uuid, p_membership_id uuid, p_subscription_id uuid
) returns table (tenant_id uuid, membership_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  t_name text;
begin
  if uid is null then
    raise exception 'create_teacher_workspace: thiếu app.user_id' using errcode = '42501';
  end if;
  -- Hai request đồng thời (khác Idempotency-Key) của cùng user: xếp hàng, request sau thấy không gian đã có.
  perform pg_advisory_xact_lock(hashtextextended('workspace:' || uid::text, 0));

  return query
    select m.tenant_id, m.id, false
      from public.memberships m join public.tenants t on t.id = m.tenant_id
     where m.user_id = uid and m.role = 'tenant_owner' and m.status = 'active' and t.type = 'teacher'
     order by m.created_at limit 1;
  if found then
    return;
  end if;

  select coalesce(u.display_name, split_part(u.email, '@', 1), 'Không gian của tôi') into t_name
    from public.users u where u.id = uid;
  insert into public.tenants (id, type, name, created_by) values (p_tenant_id, 'teacher', t_name, uid);
  insert into public.branches (id, tenant_id, name, is_default) values (p_branch_id, p_tenant_id, 'Mặc định', true);
  insert into public.memberships (id, user_id, role, tenant_id) values (p_membership_id, uid, 'tenant_owner', p_tenant_id);
  insert into public.subscriptions (id, tenant_id, plan_code) values (p_subscription_id, p_tenant_id, 'free');
  update public.users set memberships_version = memberships_version + 1 where id = uid;
  return query select p_tenant_id, p_membership_id, true;
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.create_teacher_workspace(uuid, uuid, uuid, uuid)
  from teachhub_worker, teachhub_readonly, public;
