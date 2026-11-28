CREATE TABLE "absence_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"reported_by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "absence_requests_reason_check" CHECK ("absence_requests"."reason" in ('sick', 'family', 'other')),
	CONSTRAINT "absence_requests_note_check" CHECK (char_length("absence_requests"."note") <= 300),
	CONSTRAINT "absence_requests_cancelled_check" CHECK ("absence_requests"."cancelled_at" is null or "absence_requests"."cancelled_at" >= "absence_requests"."created_at")
);
--> statement-breakpoint
ALTER TABLE "absence_requests" ADD CONSTRAINT "absence_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_requests" ADD CONSTRAINT "absence_requests_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_requests" ADD CONSTRAINT "absence_requests_tenant_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_requests" ADD CONSTRAINT "absence_requests_tenant_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "absence_requests_active_uq" ON "absence_requests" USING btree ("session_id","student_id") WHERE "absence_requests"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "absence_requests_student_idx" ON "absence_requests" USING btree ("student_id") WHERE "absence_requests"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "absence_requests_reported_by_idx" ON "absence_requests" USING btree ("reported_by_user_id");
--> statement-breakpoint
-- US-3.4 (phụ huynh báo vắng trước). Bảng mới, không đụng bảng cũ. Phụ huynh KHÔNG có quyền ghi: tạo/hủy qua hàm security
-- definer vì phải đọc buổi/ghi danh (phụ huynh không đọc được) và ghi outbox. Phụ huynh chỉ ĐỌC báo vắng của con đã liên kết.
alter table absence_requests enable row level security;
--> statement-breakpoint
alter table absence_requests force row level security;
--> statement-breakpoint
-- Nhân sự tenant đọc để điền sẵn "Vắng có phép" ở màn điểm danh (ghi: không có policy ghi cho app).
create policy absence_requests_staff_read on absence_requests for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy absence_requests_family_read on absence_requests for select to teachhub_app
  using (student_id in (select app_private.linked_student_ids()));
--> statement-breakpoint
-- Hàm security definer chạy bằng teachhub_owner, bị FORCE RLS: cần policy cho owner (cùng cách 0036).
create policy absence_requests_owner_all on absence_requests for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
revoke delete, truncate on absence_requests from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint

-- Buổi mà con ĐÃ LIÊN KẾT được báo vắng: học viên còn học, ghi danh lớp của buổi vào ngày buổi học (cùng luật điểm danh).
-- 0 dòng nếu con không liên kết với user, buổi của tenant khác/không tồn tại, hoặc con không thuộc lớp của buổi.
create or replace function app_private.family_absence_session(p_student_id uuid, p_session_id uuid)
returns table (
  tenant_id uuid, class_id uuid, class_name text, starts_at timestamptz, session_status text, timezone text, student_name text
)
language sql stable security definer set search_path = '' as $$
  select se.tenant_id, se.class_id, c.name, se.starts_at, se.status, t.timezone, s.full_name
    from public.students s
    join public.sessions se on se.tenant_id = s.tenant_id and se.id = p_session_id
    join public.classes c on c.tenant_id = se.tenant_id and c.id = se.class_id
    join public.tenants t on t.id = se.tenant_id
   where s.id = p_student_id and s.status <> 'left'
     and s.id in (select app_private.linked_student_ids())
     and exists (
       select 1 from public.enrollments e
        where e.tenant_id = se.tenant_id and e.class_id = se.class_id and e.student_id = s.id
          and e.joined_on <= se.session_date and (e.left_on is null or e.left_on > se.session_date));
$$;
--> statement-breakpoint

-- Báo vắng của con đã liên kết (mọi người giám hộ đã liên kết thấy như nhau). `p_upcoming` = chỉ báo vắng hiệu lực của buổi
-- chưa bắt đầu (danh sách "sắp tới"); false = cả đã hủy (để biết trạng thái khi hủy). Không trả dữ liệu học viên khác.
create or replace function app_private.family_absence_requests(p_student_id uuid, p_id uuid, p_upcoming boolean)
returns table (
  id uuid, session_id uuid, student_id uuid, class_id uuid, class_name text, starts_at timestamptz,
  reason text, note text, created_at timestamptz, cancelled_at timestamptz, timezone text
)
language sql stable security definer set search_path = '' as $$
  select a.id, a.session_id, a.student_id, se.class_id, c.name, se.starts_at, a.reason, a.note, a.created_at, a.cancelled_at, t.timezone
    from public.absence_requests a
    join public.sessions se on se.tenant_id = a.tenant_id and se.id = a.session_id
    join public.classes c on c.tenant_id = se.tenant_id and c.id = se.class_id
    join public.tenants t on t.id = a.tenant_id
   where a.student_id in (select app_private.linked_student_ids())
     and (p_student_id is null or a.student_id = p_student_id)
     and (p_id is null or a.id = p_id)
     and (not p_upcoming or (a.cancelled_at is null and se.starts_at > now()))
   order by se.starts_at, a.id;
$$;
--> statement-breakpoint

-- Tạo báo vắng. Kiểm lại (nguồn cuối, cùng giao dịch) liên kết, ghi danh, buổi chưa bắt đầu và không hủy; đã có báo vắng hiệu lực
-- thì trả bản đó (`created = false`, không outbox). Tạo mới ghi outbox `student_absence_reported` cùng giao dịch.
-- Trả jsonb {result: ok | not_found | cancelled | started, id, created}.
create or replace function app_private.create_absence_request(p_session_id uuid, p_student_id uuid, p_reason text, p_note text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  ctx record; rid uuid;
begin
  if uid is null then
    raise exception 'create_absence_request: cần người dùng đăng nhập' using errcode = '42501';
  end if;
  select * into ctx from app_private.family_absence_session(p_student_id, p_session_id);
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if ctx.session_status = 'cancelled' then return jsonb_build_object('result', 'cancelled'); end if;
  if ctx.starts_at <= now() then return jsonb_build_object('result', 'started'); end if;

  select a.id into rid from public.absence_requests a
   where a.session_id = p_session_id and a.student_id = p_student_id and a.cancelled_at is null;
  if found then return jsonb_build_object('result', 'ok', 'id', rid, 'created', false); end if;
  begin
    insert into public.absence_requests (id, tenant_id, session_id, student_id, reported_by_user_id, reason, note)
    values (gen_random_uuid(), ctx.tenant_id, p_session_id, p_student_id, uid, p_reason, nullif(p_note, ''))
    returning id into rid;
  exception when unique_violation then
    -- Hai người giám hộ (hoặc hai request) báo cùng lúc: giữ bản đã commit.
    select a.id into rid from public.absence_requests a
     where a.session_id = p_session_id and a.student_id = p_student_id and a.cancelled_at is null;
    return jsonb_build_object('result', 'ok', 'id', rid, 'created', false);
  end;
  insert into public.outbox_events (id, tenant_id, type, payload)
    values (gen_random_uuid(), ctx.tenant_id, 'student_absence_reported', jsonb_build_object('absenceRequestId', rid));
  return jsonb_build_object('result', 'ok', 'id', rid, 'created', true);
end;
$$;
--> statement-breakpoint

-- Hủy báo vắng trước giờ bắt đầu. Người giám hộ đã liên kết với con hủy được (không riêng người báo). Đã hủy rồi → 'ok' (idempotent).
-- Trả 'ok' | 'not_found' | 'started'.
create or replace function app_private.cancel_absence_request(p_id uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  a public.absence_requests; starts timestamptz;
begin
  if uid is null then
    raise exception 'cancel_absence_request: cần người dùng đăng nhập' using errcode = '42501';
  end if;
  select r.* into a from public.absence_requests r
   where r.id = p_id and r.student_id in (select app_private.linked_student_ids())
   for update;
  if not found then return 'not_found'; end if;
  if a.cancelled_at is not null then return 'ok'; end if;
  select se.starts_at into starts from public.sessions se where se.tenant_id = a.tenant_id and se.id = a.session_id;
  if starts <= now() then return 'started'; end if;
  update public.absence_requests set cancelled_at = now() where id = a.id;
  return 'ok';
end;
$$;
--> statement-breakpoint
revoke execute on function
  app_private.family_absence_session(uuid, uuid),
  app_private.family_absence_requests(uuid, uuid, boolean),
  app_private.create_absence_request(uuid, uuid, text, text),
  app_private.cancel_absence_request(uuid)
  from teachhub_worker, teachhub_readonly, public;
