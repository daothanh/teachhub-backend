ALTER TABLE "sessions" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "makeup_of" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rescheduled_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_makeup_of_fk" FOREIGN KEY ("tenant_id","makeup_of") REFERENCES "public"."sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_makeup_of_uq" ON "sessions" USING btree ("makeup_of") WHERE "sessions"."makeup_of" is not null;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cancel_reason_check" CHECK (char_length("sessions"."cancel_reason") <= 300);
--> statement-breakpoint
-- S4-BE-09 (US-0.9): xóa tài khoản. Hàm security definer chạy bằng teachhub_owner (cũng bị FORCE RLS) nên cần policy
-- riêng cho các bảng mà api không được ghi: học viên, phụ huynh, thông báo, đăng ký sớm. User lấy từ app.user_id.
create policy students_owner_all on students for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy guardians_owner_all on guardians for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy notifications_owner_all on notifications for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy center_waitlist_owner_all on center_waitlist for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint

-- Xóa: refresh token, thiết bị, danh tính đăng nhập, thông báo, đăng ký sớm, membership; gỡ guardians.user_id;
-- ẩn danh dòng users (giữ id để khóa ngoại và audit_logs còn trỏ được, email = null nên email cũ đăng nhập lại ra user mới).
-- Không gian mà user là nhân sự duy nhất: đánh dấu xóa, ẩn danh học viên và phụ huynh trong đó (Spec §4.8).
-- Giữ nguyên: hóa đơn, thanh toán, sổ doanh thu, audit_logs (5 năm sau xóa, job xóa hẳn làm ở sprint tài chính).
create or replace function app_private.delete_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  sole uuid[];
begin
  if uid is null then
    raise exception 'delete_account: thiếu app.user_id' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct m.tenant_id), '{}') into sole
    from public.memberships m
   where m.user_id = uid and m.status = 'active'
     and m.role in ('tenant_owner', 'teacher', 'accountant', 'branch_manager')
     and not exists (
       select 1 from public.memberships o
        where o.tenant_id = m.tenant_id and o.user_id <> uid and o.status = 'active'
          and o.role in ('tenant_owner', 'teacher', 'accountant', 'branch_manager'));

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
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.delete_account() from teachhub_worker, teachhub_readonly, public;
