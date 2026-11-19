ALTER TABLE "notifications" ADD COLUMN "event_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notifications_absence_lookup_idx" ON "notifications" USING btree ("tenant_id",("payload" ->> 'sessionId'),("payload" ->> 'studentId')) WHERE "notifications"."type" = 'student_absent';--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_token_length_check" CHECK (char_length("devices"."token") <= 4096);--> statement-breakpoint
-- M4: owner chỉ đọc được audit của attendance trong tenant mà người gọi là nhân sự (trước đây `using (true)`).
drop policy audit_logs_owner_select on audit_logs;
--> statement-breakpoint
create policy audit_logs_owner_select on audit_logs for select to teachhub_owner
  using (entity = 'attendance' and tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
-- S6: cột thứ ba của index nhật ký là `id desc` cho khớp `order by id desc` và con trỏ id.
drop index audit_logs_attendance_session_idx;
--> statement-breakpoint
create index audit_logs_attendance_session_idx on audit_logs (tenant_id, (coalesce(after_data, before_data) ->> 'session_id'), id desc)
  where entity = 'attendance';
--> statement-breakpoint
-- M4: hàm lịch sử còn kiểm người gọi là tenant_owner của p_tenant_id (nhân sự thường không đọc được dù gọi thẳng hàm).
create or replace function app_private.attendance_history(
  p_tenant_id uuid, p_session_id uuid, p_before_id bigint, p_limit integer
) returns table (
  id bigint, student_id uuid, changed_by_name text, changed_at timestamptz,
  before_status text, before_note text, after_status text, after_note text
)
language sql stable security definer set search_path = '' as $$
  select a.id,
         (coalesce(a.after_data, a.before_data) ->> 'student_id')::uuid,
         u.display_name,
         a.created_at,
         a.before_data ->> 'status',
         a.before_data ->> 'note',
         a.after_data ->> 'status',
         a.after_data ->> 'note'
    from public.audit_logs a
    left join public.users u on u.id = a.actor_user_id
   where exists (
           select 1 from public.memberships m
            where m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
              and m.tenant_id = p_tenant_id and m.role = 'tenant_owner' and m.status = 'active')
     and a.tenant_id = p_tenant_id
     and a.entity = 'attendance'
     and (coalesce(a.after_data, a.before_data) ->> 'session_id') = p_session_id::text
     and (p_before_id is null or a.id < p_before_id)
   order by a.id desc
   limit least(p_limit, 101);
$$;
--> statement-breakpoint
-- S2: mỗi user giữ tối đa 10 thiết bị; vượt thì xóa thiết bị lâu không thấy nhất.
create or replace function app_private.register_device(p_id uuid, p_token text, p_platform text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  if uid is null then
    raise exception 'thiếu app.user_id' using errcode = 'insufficient_privilege';
  end if;
  delete from public.devices where token = p_token and user_id <> uid;
  insert into public.devices (id, user_id, platform, token)
    values (p_id, uid, p_platform, p_token)
    on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now();
  delete from public.devices where id in (
    select id from public.devices where user_id = uid order by last_seen_at desc, id desc offset 10);
end;
$$;
