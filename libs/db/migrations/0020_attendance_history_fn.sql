-- Nhật ký sửa điểm danh của một buổi (S3-BE-03, US-3.3 AC2). API không có quyền đọc audit_logs: đọc qua một hàm
-- security definer chỉ trả bản ghi entity `attendance` của đúng (tenant, buổi), và chỉ khi người gọi là nhân sự tenant đó.
-- Hàm chạy bằng teachhub_owner, cũng bị FORCE RLS: cần policy đọc cho owner (policy cho app vẫn không có).
create policy audit_logs_owner_select on audit_logs for select to teachhub_owner using (true);
--> statement-breakpoint
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
   where p_tenant_id in (select app_private.staff_tenant_ids())
     and a.tenant_id = p_tenant_id
     and a.entity = 'attendance'
     and (coalesce(a.after_data, a.before_data) ->> 'session_id') = p_session_id::text
     and (p_before_id is null or a.id < p_before_id)
   order by a.id desc
   limit least(p_limit, 101);
$$;
--> statement-breakpoint
revoke execute on function app_private.attendance_history(uuid, uuid, bigint, integer)
  from teachhub_worker, teachhub_readonly, public;
