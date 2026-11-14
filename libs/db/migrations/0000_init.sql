-- Khởi tạo nền: extension, schema app_private, quyền mặc định, hàm dùng chung.
-- Yêu cầu các vai trò teachhub_owner/app/worker/readonly đã tồn tại (local: docker/postgres-init, prod: Ansible).
create extension if not exists pgcrypto;
--> statement-breakpoint
create extension if not exists pg_trgm;
--> statement-breakpoint
create extension if not exists unaccent;
--> statement-breakpoint
create extension if not exists btree_gist;
--> statement-breakpoint

-- Hàm helper cho RLS (staff_tenant_ids, linked_student_ids — Mục 4.5) đặt trong schema này từ Sprint 1.
create schema if not exists app_private;
--> statement-breakpoint
revoke all on schema app_private from public;
--> statement-breakpoint
grant usage on schema app_private to teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint
grant usage on schema public to teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint

-- Bảng do teachhub_owner tạo tự cấp quyền DML cho api/worker, chỉ đọc cho readonly.
alter default privileges for role teachhub_owner in schema public
  grant select, insert, update, delete on tables to teachhub_app, teachhub_worker;
--> statement-breakpoint
alter default privileges for role teachhub_owner in schema public
  grant select on tables to teachhub_readonly;
--> statement-breakpoint
alter default privileges for role teachhub_owner in schema public
  grant usage, select on sequences to teachhub_app, teachhub_worker;
--> statement-breakpoint
alter default privileges for role teachhub_owner in schema app_private
  grant execute on functions to teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint

-- Trigger dùng chung: trg_<bảng>_updated_at.
create or replace function app_private.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
