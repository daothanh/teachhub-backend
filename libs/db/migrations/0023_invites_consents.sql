CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"terms_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	CONSTRAINT "consents_role_check" CHECK ("consents"."role" in ('parent', 'student', 'tenant_owner')),
	CONSTRAINT "consents_user_agent_length_check" CHECK (char_length("consents"."user_agent") <= 255)
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"kind" text DEFAULT 'parent' NOT NULL,
	"token_hash" text NOT NULL,
	"short_code_hash" text NOT NULL,
	"short_code_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" uuid,
	"accepted_by_name" text,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_kind_check" CHECK ("invites"."kind" in ('parent', 'student')),
	CONSTRAINT "invites_status_check" CHECK ("invites"."status" in ('pending', 'used', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_tenant_student_id_uq" UNIQUE("tenant_id","student_id","id");--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_student_guardian_fk" FOREIGN KEY ("tenant_id","student_id","guardian_id") REFERENCES "public"."guardians"("tenant_id","student_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_user_role_version_idx" ON "consents" USING btree ("user_id","role","terms_version","accepted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "invites_short_code_pending_uq" ON "invites" USING btree ("short_code_hash") WHERE "invites"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "invites_guardian_pending_uq" ON "invites" USING btree ("guardian_id") WHERE "invites"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "invites_tenant_student_idx" ON "invites" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "invites_guardian_created_idx" ON "invites" USING btree ("guardian_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invites_used_by_idx" ON "invites" USING btree ("used_by") WHERE "invites"."used_by" is not null;--> statement-breakpoint

--> statement-breakpoint
-- ===== RLS =====
-- invites: nhân sự tenant đọc/ghi lời mời của tenant mình. Phụ huynh (chưa có quyền gì ở tenant) chỉ đi qua
-- hàm security definer preview_invite/redeem_invite bên dưới, nên không có policy cho họ.
alter table invites enable row level security;
--> statement-breakpoint
alter table invites force row level security;
--> statement-breakpoint
create policy invites_staff_all on invites for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
-- Hàm security definer chạy bằng teachhub_owner, cũng bị FORCE RLS → cần policy cho owner (api/worker không dùng vai trò này).
create policy invites_owner_all on invites for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy guardians_owner_all on guardians for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy students_owner_read on students for select to teachhub_owner using (true);
--> statement-breakpoint
create policy enrollments_owner_read on enrollments for select to teachhub_owner using (true);
--> statement-breakpoint
create policy classes_owner_read on classes for select to teachhub_owner using (true);
--> statement-breakpoint
create policy sessions_owner_read on sessions for select to teachhub_owner using (true);
--> statement-breakpoint
create policy attendance_owner_read on attendance for select to teachhub_owner using (true);
--> statement-breakpoint

-- consents: user chỉ đọc và thêm dòng của chính mình. Không có policy UPDATE/DELETE, thu quyền ở mức bảng,
-- và trigger chặn cả vai trò BYPASSRLS/owner (bằng chứng pháp lý không được sửa hay xóa).
alter table consents enable row level security;
--> statement-breakpoint
alter table consents force row level security;
--> statement-breakpoint
create policy consents_self_read on consents for select to teachhub_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
create policy consents_self_insert on consents for insert to teachhub_app
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
revoke update, delete, truncate on consents from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint
create or replace function app_private.consents_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'consents chỉ ghi thêm, không cho phép %', tg_op using errcode = '42501';
end;
$$;
--> statement-breakpoint
create trigger trg_consents_append_only before update or delete on consents
  for each row execute function app_private.consents_append_only();
--> statement-breakpoint
create trigger trg_consents_no_truncate before truncate on consents
  for each statement execute function app_private.consents_append_only();
--> statement-breakpoint

-- ===== Hàm security definer =====
-- Học viên mà user hiện tại là phụ huynh đã kích hoạt và chưa bị gỡ liên kết (Spec §4.5). Gỡ phụ huynh khỏi
-- `guardians` (deleted_at) làm mất quyền ngay, không chờ cache.
create or replace function app_private.linked_student_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select g.student_id from public.guardians g
   where g.user_id = nullif(current_setting('app.user_id', true), '')::uuid
     and g.deleted_at is null;
$$;
--> statement-breakpoint

-- Xem trước lời mời (công khai, không cần user): chỉ tên giáo viên, tên gọi của trẻ (từ cuối của họ tên), hạn.
-- Token sai/hết hạn/đã dùng/thu hồi/phụ huynh đã bị gỡ đều cho 0 dòng.
create or replace function app_private.preview_invite(p_token_hash text)
returns table (teacher_name text, student_given_name text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select coalesce(o.display_name, t.name),
         regexp_replace(btrim(s.full_name), '^.*\s', ''),
         i.expires_at
    from public.invites i
    join public.students s on s.tenant_id = i.tenant_id and s.id = i.student_id
    join public.tenants t on t.id = i.tenant_id
    join public.guardians g on g.id = i.guardian_id and g.deleted_at is null and g.user_id is null
    left join lateral (
      select u.display_name
        from public.memberships m join public.users u on u.id = m.user_id
       where m.tenant_id = i.tenant_id and m.role = 'tenant_owner' and m.status = 'active'
       order by m.created_at limit 1
    ) o on true
   where i.token_hash = p_token_hash and i.status = 'pending' and i.expires_at > now();
$$;
--> statement-breakpoint

-- Nhận lời mời bằng token (p_by_code = false) hoặc mã ngắn (true): MỘT câu UPDATE ... RETURNING nguyên tử, hai
-- request song song cùng token thì chỉ một thắng. Trả 0 dòng cho mọi lý do thất bại (không phân biệt được).
-- Thành công: gắn guardians.user_id, tạo/kích hoạt membership Phụ huynh (gộp vào tài khoản có sẵn), tăng
-- memberships_version, ghi audit (không chứa token/mã). User lấy từ app.user_id, không nhận từ tham số.
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
         accepted_by_name = (select coalesce(u.display_name, split_part(u.email, '@', 1), 'Phụ huynh')
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

-- /family: các con và lớp đang học, chỉ cột cần hiển thị (không ghi chú, ngày sinh, liên hệ). Lọc theo
-- linked_student_ids() chứ không theo tenant: phụ huynh nhiều giáo viên thấy hết.
create or replace function app_private.family_students()
returns table (student_id uuid, full_name text, class_id uuid, class_name text, teacher_name text)
language sql stable security definer set search_path = '' as $$
  select s.id, s.full_name, c.id, c.name, coalesce(o.display_name, t.name)
    from public.students s
    join public.tenants t on t.id = s.tenant_id
    left join public.enrollments e on e.tenant_id = s.tenant_id and e.student_id = s.id and e.left_on is null
    left join public.classes c on c.tenant_id = e.tenant_id and c.id = e.class_id and c.status = 'active'
    left join lateral (
      select u.display_name
        from public.memberships m join public.users u on u.id = m.user_id
       where m.tenant_id = s.tenant_id and m.role = 'tenant_owner' and m.status = 'active'
       order by m.created_at limit 1
    ) o on true
   where s.id in (select app_private.linked_student_ids()) and s.status <> 'left'
   order by s.full_name, s.id, c.name, c.id;
$$;
--> statement-breakpoint

-- Múi giờ tenant của con đã liên kết; 0 dòng nếu không liên kết (học viên khác, tenant khác, đã gỡ, không tồn tại).
create or replace function app_private.family_student_timezone(p_student_id uuid)
returns table (timezone text)
language sql stable security definer set search_path = '' as $$
  select t.timezone
    from public.students s join public.tenants t on t.id = s.tenant_id
   where s.id = p_student_id and s.status <> 'left'
     and s.id in (select app_private.linked_student_ids());
$$;
--> statement-breakpoint

-- Buổi học của con trong [p_from, p_to] (ngày theo múi giờ tenant) kèm trạng thái điểm danh của ĐÚNG con này.
-- Không trả `note` hay điểm danh của học viên khác. Buổi hủy → điểm danh null.
create or replace function app_private.family_week_sessions(p_student_id uuid, p_from date, p_to date)
returns table (
  session_id uuid, class_id uuid, class_name text, starts_at timestamptz, ends_at timestamptz,
  session_status text, is_makeup boolean, attendance_status text
)
language sql stable security definer set search_path = '' as $$
  select se.id, se.class_id, c.name, se.starts_at, se.ends_at, se.status, se.is_makeup,
         case when se.status = 'cancelled' then null else a.status end
    from public.students s
    join public.enrollments e on e.tenant_id = s.tenant_id and e.student_id = s.id
    join public.sessions se on se.tenant_id = e.tenant_id and se.class_id = e.class_id
         and se.session_date >= e.joined_on and (e.left_on is null or se.session_date <= e.left_on)
    join public.classes c on c.tenant_id = se.tenant_id and c.id = se.class_id
    left join public.attendance a on a.tenant_id = se.tenant_id and a.session_id = se.id and a.student_id = s.id
   where s.id = p_student_id and s.status <> 'left'
     and s.id in (select app_private.linked_student_ids())
     and se.session_date between p_from and p_to
   order by se.starts_at, se.id;
$$;
--> statement-breakpoint

revoke execute on function
  app_private.preview_invite(text),
  app_private.redeem_invite(boolean, text, uuid),
  app_private.family_students(),
  app_private.family_student_timezone(uuid),
  app_private.family_week_sessions(uuid, date, date),
  app_private.linked_student_ids()
  from teachhub_worker, teachhub_readonly, public;
