-- RLS, updated_at, audit, seed gói cho bảng tenancy (Technical Spec §4.4, §4.5).
-- Tạo tenant + chi nhánh mặc định + chủ tenant + subscription đi qua hàm security definer của
-- POST /workspaces (S1-BE-08): lúc tạo, user chưa là nhân sự nên policy theo staff_tenant_ids() chặn.

alter table tenants enable row level security;
--> statement-breakpoint
alter table tenants force row level security;
--> statement-breakpoint
create policy tenants_staff_read on tenants for select to teachhub_app
  using (id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy tenants_staff_update on tenants for update to teachhub_app
  using (id in (select app_private.staff_tenant_ids()))
  with check (id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint

alter table branches enable row level security;
--> statement-breakpoint
alter table branches force row level security;
--> statement-breakpoint
create policy branches_staff_all on branches for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint

-- Gói: tự đổi gói = tự nâng cấp Pro → app chỉ đọc; worker (RevenueCat, chuyển khoản) ghi.
alter table subscriptions enable row level security;
--> statement-breakpoint
alter table subscriptions force row level security;
--> statement-breakpoint
create policy subscriptions_staff_read on subscriptions for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint

-- Danh mục gói dùng chung, không thuộc tenant: ai cũng đọc, chỉ migration (owner) ghi.
alter table plans enable row level security;
--> statement-breakpoint
alter table plans force row level security;
--> statement-breakpoint
create policy plans_read on plans for select to teachhub_app, teachhub_worker using (true);
--> statement-breakpoint
create policy plans_owner_all on plans for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint

-- Giới hạn gói (US-0.7): null = không giới hạn. Chạy lại an toàn: migration sau đổi số chỉ cần sửa
-- hàm rồi gọi lại.
create or replace function app_private.upsert_plans() returns void
language sql security definer set search_path = '' as $$
  insert into public.plans (code, limits) values
    ('free', '{"max_active_classes": 3, "max_active_students": 20}'),
    ('pro', '{"max_active_classes": null, "max_active_students": null}')
  on conflict (code) do update set limits = excluded.limits;
$$;
--> statement-breakpoint
revoke execute on function app_private.upsert_plans() from teachhub_app, teachhub_worker, teachhub_readonly, public;
--> statement-breakpoint
select app_private.upsert_plans();
--> statement-breakpoint

create trigger trg_tenants_updated_at before update on tenants
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
create trigger trg_branches_updated_at before update on branches
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
create trigger trg_subscriptions_updated_at before update on subscriptions
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint

-- Đổi gói ảnh hưởng tính năng và tiền → audit.
select app_private.enable_audit('subscriptions');
