-- Vòng rà soát lớp CSDL: (1) redeem_invite chặn tài khoản đã xóa như 0023; (2) chỉ chủ tenant ghi bảng tiền
-- (billing_periods, invoices, invoice_lines, payout_accounts), nhân sự khác chỉ đọc; (3) worker tạo trước phân vùng audit.

-- (1) Kiểm users.deleted_at và khóa dòng users TRƯỚC advisory lock, guardians, invites (thứ tự như delete_account).
-- Khóa `for no key update` chứ không `for share`: hàm này cuối cùng cũng update users (memberships_version); giữ
-- `for share` rồi nâng khóa thì hai lần nhận song song của cùng user (cả hai đã giữ share, một bên chờ advisory lock)
-- sẽ deadlock. `for no key update` vẫn xung đột với `for update` của delete_account nên tuần tự hóa với lệnh xóa.
create or replace function app_private.redeem_invite(p_by_code boolean, p_hash text, p_membership_id uuid)
returns table (membership_id uuid, student_id uuid, student_name text, invite_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  inv record;
  m_id uuid;
  m_status text;
  g_id uuid;
begin
  if uid is null then
    raise exception 'redeem_invite: thiếu app.user_id' using errcode = '42501';
  end if;
  perform 1 from public.users u where u.id = uid and u.deleted_at is null for no key update;
  if not found then
    raise exception 'redeem_invite: tài khoản không còn' using errcode = '42501';
  end if;
  -- Tuần tự hóa các lần nhận song song của cùng user: tránh hai lần cùng tạo membership Phụ huynh (unique → 500).
  perform pg_advisory_xact_lock(hashtextextended('redeem_invite:' || uid::text, 0));

  -- shortcut: membership Phụ huynh đã `revoked` thì không khôi phục (bảng chưa phân biệt bị gỡ hay tự gỡ); trả 0 dòng
  -- → 410 đồng nhất. Chờ Owner chốt có cho tự gỡ rồi nhận lại không. Kiểm TRƯỚC khi dùng lời mời để không đốt nó.
  select m.id, m.status into m_id, m_status from public.memberships m
   where m.user_id = uid and m.role = 'parent' and m.tenant_id is null and m.student_id is null;
  if m_id is not null and m_status <> 'active' then
    return;
  end if;

  -- Thứ tự khóa giống InvitesService.issue: phụ huynh (FOR NO KEY UPDATE) trước, lời mời sau, tránh deadlock.
  select i.guardian_id into g_id from public.invites i
   where case when p_by_code then i.short_code_hash = p_hash else i.token_hash = p_hash end
     and i.kind = 'parent' and i.status = 'pending';
  if g_id is null then
    return;
  end if;
  perform 1 from public.guardians g where g.id = g_id for no key update;

  update public.invites i
     set status = 'used', used_at = now(), used_by = uid,
         accepted_by_name = (select coalesce(u.display_name, 'Phụ huynh')
                               from public.users u where u.id = uid)
   where case when p_by_code then i.short_code_hash = p_hash and i.short_code_expires_at > now()
              else i.token_hash = p_hash end
     and i.kind = 'parent' and i.status = 'pending' and i.expires_at > now()
     and exists (select 1 from public.guardians g
                  where g.id = i.guardian_id and g.deleted_at is null and g.user_id is null)
  returning i.id, i.tenant_id, i.student_id, i.guardian_id into inv;
  if not found then
    return;
  end if;

  update public.guardians set user_id = uid where id = inv.guardian_id;

  if m_id is null then
    insert into public.memberships (id, user_id, role) values (p_membership_id, uid, 'parent') returning id into m_id;
  end if;
  update public.users set memberships_version = memberships_version + 1 where id = uid;

  perform app_private.audit_insert(
    inv.tenant_id, 'invite', inv.id, 'update',
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'used', 'guardian_id', inv.guardian_id, 'by_code', p_by_code)
  );
  return query
    select m_id, inv.student_id, s.full_name, inv.id
      from public.students s where s.tenant_id = inv.tenant_id and s.id = inv.student_id;
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.redeem_invite(boolean, text, uuid) from teachhub_worker, teachhub_readonly, public;
--> statement-breakpoint
grant execute on function app_private.redeem_invite(boolean, text, uuid) to teachhub_app;
--> statement-breakpoint

-- (2) Như payments/student_ledger (0026): mọi nhân sự đọc, chỉ tenant_owner ghi (đúng controller `@RequiresRole('tenant_owner')`).
-- Worker (BYPASSRLS) và hàm security definer chạy bằng teachhub_owner (policy *_owner_all riêng) không bị ảnh hưởng.
drop policy payout_accounts_staff_all on payout_accounts;
--> statement-breakpoint
create policy payout_accounts_staff_read on payout_accounts for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy payout_accounts_tenant_owner_write on payout_accounts for all to teachhub_app
  using (tenant_id in (select app_private.owner_tenant_ids()))
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint
drop policy billing_periods_staff_all on billing_periods;
--> statement-breakpoint
create policy billing_periods_staff_read on billing_periods for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy billing_periods_tenant_owner_write on billing_periods for all to teachhub_app
  using (tenant_id in (select app_private.owner_tenant_ids()))
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint
drop policy invoices_staff_all on invoices;
--> statement-breakpoint
create policy invoices_staff_read on invoices for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy invoices_tenant_owner_write on invoices for all to teachhub_app
  using (tenant_id in (select app_private.owner_tenant_ids()))
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint
drop policy invoice_lines_staff_all on invoice_lines;
--> statement-breakpoint
create policy invoice_lines_staff_read on invoice_lines for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy invoice_lines_tenant_owner_write on invoice_lines for all to teachhub_app
  using (tenant_id in (select app_private.owner_tenant_ids()))
  with check (tenant_id in (select app_private.owner_tenant_ids()));
--> statement-breakpoint

-- (3) Job `infra.ensure-audit-partitions` của worker tạo trước phân vùng tháng này và tháng sau, để audit_insert trong
-- giao dịch người dùng không phải tạo phân vùng (ACCESS EXCLUSIVE trên audit_logs). Nhánh tạo lười giữ làm dự phòng.
revoke execute on function app_private.ensure_audit_partition(timestamptz) from teachhub_app, teachhub_readonly, public;
--> statement-breakpoint
grant execute on function app_private.ensure_audit_partition(timestamptz) to teachhub_worker;
