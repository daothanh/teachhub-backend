-- RLS, updated_at, audit cho bảng danh tính (Technical Spec §4.5; ADR-TH-BE-001 §3).
-- Mọi bảng chỉ cho teachhub_app thấy dòng của chính user (app.user_id). Tra cứu khi chưa biết user
-- (đăng nhập theo email/identity, làm mới theo băm token) đi qua hàm security definer ở S1-BE-04/05.

alter table users enable row level security;
--> statement-breakpoint
alter table users force row level security;
--> statement-breakpoint
create policy users_self on users for all to teachhub_app
  using (id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

alter table auth_identities enable row level security;
--> statement-breakpoint
alter table auth_identities force row level security;
--> statement-breakpoint
create policy auth_identities_self on auth_identities for all to teachhub_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

alter table refresh_tokens enable row level security;
--> statement-breakpoint
alter table refresh_tokens force row level security;
--> statement-breakpoint
create policy refresh_tokens_self on refresh_tokens for all to teachhub_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

alter table memberships enable row level security;
--> statement-breakpoint
alter table memberships force row level security;
--> statement-breakpoint
-- Vai trò là quyền truy cập: app chỉ đọc vai trò của mình và tự thêm vai trò phụ huynh/học sinh chưa
-- gắn tenant/học viên (POST /me/roles). Vai trò nhân sự, gắn học viên, đổi trạng thái (thu hồi, kích hoạt
-- lại) đi qua hàm security definer có kiểm quyền (POST /workspaces S1-BE-08, lời mời Sprint 2) — một lỗi
-- ở API không tự cấp được vai trò ở tenant khác.
create policy memberships_self_read on memberships for select to teachhub_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
create policy memberships_self_family_insert on memberships for insert to teachhub_app
  with check (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and role in ('parent', 'student')
    and tenant_id is null
    and student_id is null
  );
--> statement-breakpoint
-- Hàm helper security definer chạy bằng teachhub_owner, cũng bị FORCE RLS: cho owner đọc để
-- staff_tenant_ids() không đệ quy qua chính policy của memberships.
create policy memberships_owner_read on memberships for select to teachhub_owner using (true);
--> statement-breakpoint

-- Các tenant mà user hiện tại là nhân sự (§4.5); policy của mọi bảng nghiệp vụ dùng hàm này.
create or replace function app_private.staff_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.memberships m
   where m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
     and m.status = 'active'
     and m.role in ('tenant_owner', 'teacher', 'accountant', 'branch_manager');
$$;
--> statement-breakpoint

create trigger trg_users_updated_at before update on users
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
create trigger trg_memberships_updated_at before update on memberships
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint

-- Cấp/thu hồi vai trò là thay đổi quyền truy cập → ghi audit. users không audit (đổi vai trò gần
-- nhất, `memberships_version` mỗi lần chuyển vai trò — nhiễu, không có dữ liệu cần truy vết).
select app_private.enable_audit('memberships');
