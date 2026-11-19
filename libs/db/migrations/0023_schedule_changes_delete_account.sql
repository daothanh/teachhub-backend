ALTER TABLE "sessions" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "makeup_of" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rescheduled_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_makeup_of_fk" FOREIGN KEY ("tenant_id","makeup_of") REFERENCES "public"."sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_makeup_of_uq" ON "sessions" USING btree ("makeup_of") WHERE "sessions"."makeup_of" is not null and "sessions"."status" <> 'cancelled';--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cancel_reason_check" CHECK (char_length("sessions"."cancel_reason") <= 300);
--> statement-breakpoint
-- S4-BE-09 (US-0.9): xóa tài khoản. Hàm security definer chạy bằng teachhub_owner (cũng bị FORCE RLS) nên cần policy
-- riêng cho các bảng mà api không được ghi: học viên, phụ huynh, thông báo, đăng ký sớm; và đọc lớp để kiểm lớp active.
create policy students_owner_all on students for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy guardians_owner_all on guardians for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy notifications_owner_all on notifications for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy center_waitlist_owner_all on center_waitlist for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy classes_owner_read on classes for select to teachhub_owner using (true);
--> statement-breakpoint

-- Chốt ở DB: tài khoản đã xóa không tự thêm vai trò được nữa (access token cũ còn hạn tối đa 15 phút).
drop policy memberships_self_family_insert on memberships;
--> statement-breakpoint
create policy memberships_self_family_insert on memberships for insert to teachhub_app
  with check (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and role in ('parent', 'student')
    and tenant_id is null
    and student_id is null
    and exists (select 1 from users u where u.id = memberships.user_id and u.deleted_at is null)
  );
--> statement-breakpoint
create or replace function app_private.register_device(p_id uuid, p_token text, p_platform text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  if uid is null then
    raise exception 'thiếu app.user_id' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.users where id = uid and deleted_at is null) then
    raise exception 'tài khoản đã xóa' using errcode = 'insufficient_privilege';
  end if;
  delete from public.devices where token = p_token and user_id <> uid;
  insert into public.devices (id, user_id, platform, token)
    values (p_id, uid, p_platform, p_token)
    on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now();
  delete from public.devices where id in (
    select id from public.devices where user_id = uid order by last_seen_at desc, id desc offset 10);
end;
$$;
--> statement-breakpoint

-- Xóa tài khoản. Khóa dòng users và các tenant của user trước, rồi mới tính "nhân sự duy nhất" và kiểm lớp.
-- Trả mã chặn (`OWNER_HAS_STAFF`, `TENANT_HAS_ACTIVE_CLASSES`) mà không đổi gì; `p_check_only` chỉ khóa và kiểm.
-- shortcut: quy tắc chủ tenant tạm thời, Owner chưa chốt. (a) chủ còn nhân sự khác → chặn, phải chuyển quyền trước;
-- (b) nhân sự duy nhất còn lớp active → chặn; (c) nhân sự duy nhất hết lớp → đánh dấu tenant xóa, ẩn danh học viên, phụ huynh.
-- shortcut: tệp (avatar, object storage) chưa bị xóa, chờ job dọn; hóa đơn, thanh toán, sổ doanh thu, audit_logs giữ nguyên.
create or replace function app_private.delete_account(p_check_only boolean default false) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  mine uuid[];
  sole uuid[];
begin
  if uid is null then
    raise exception 'delete_account: thiếu app.user_id' using errcode = '42501';
  end if;
  perform 1 from public.users where id = uid and deleted_at is null for update;
  if not found then
    raise exception 'delete_account: tài khoản không còn' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct m.tenant_id), '{}') into mine
    from public.memberships m
   where m.user_id = uid and m.status = 'active'
     and m.role in ('tenant_owner', 'teacher', 'accountant', 'branch_manager');
  perform 1 from public.tenants where id = any(mine) order by id for update;

  select coalesce(array_agg(t), '{}') into sole from unnest(mine) t
   where not exists (
     select 1 from public.memberships o
      where o.tenant_id = t and o.user_id <> uid and o.status = 'active'
        and o.role in ('tenant_owner', 'teacher', 'accountant', 'branch_manager'));

  if exists (
    select 1 from public.memberships m
     where m.user_id = uid and m.status = 'active' and m.role = 'tenant_owner'
       and m.tenant_id = any(mine) and not (m.tenant_id = any(sole))) then
    return 'OWNER_HAS_STAFF';
  end if;
  if exists (select 1 from public.classes c where c.tenant_id = any(sole) and c.status = 'active') then
    return 'TENANT_HAS_ACTIVE_CLASSES';
  end if;
  if p_check_only then
    return null;
  end if;

  update public.students
     set full_name = 'Học viên đã xóa #' || right(id::text, 4),
         dob = null, school = null, school_class = null, note = null
   where tenant_id = any(sole);
  update public.guardians
     set full_name = 'Phụ huynh đã xóa', phone = null, email = null, user_id = null
   where tenant_id = any(sole);
  update public.tenants set name = 'Không gian đã xóa', deleted_at = now() where id = any(sole);

  update public.guardians set user_id = null where user_id = uid;
  delete from public.notifications where recipient_user_id = uid;
  delete from public.devices where user_id = uid;
  delete from public.refresh_tokens where user_id = uid;
  delete from public.auth_identities where user_id = uid;
  delete from public.center_waitlist where user_id = uid;
  delete from public.memberships where user_id = uid;
  update public.users
     set email = null, display_name = null, avatar_file_id = null, last_membership_id = null,
         memberships_version = memberships_version + 1, deleted_at = now()
   where id = uid;
  return null;
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.delete_account(boolean) from teachhub_worker, teachhub_readonly, public;
