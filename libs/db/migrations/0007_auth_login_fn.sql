-- Đăng nhập (S1-BE-04, dùng lại ở SSO S1-BE-06): lúc này chưa biết user nên RLS theo app.user_id trả 0 dòng.
-- Tra cứu/tạo user + identity đi qua một hàm security definer duy nhất; app không tự thêm identity nữa
-- (tự gắn `subject` Google/email của người khác vào tài khoản mình = chiếm đăng nhập của họ).

-- Hàm security definer chạy bằng teachhub_owner, cũng bị FORCE RLS.
create policy users_owner_all on users for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy auth_identities_owner_all on auth_identities for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
drop policy auth_identities_self on auth_identities;
--> statement-breakpoint
create policy auth_identities_self_read on auth_identities for select to teachhub_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint

-- Trả user của (provider, subject); chưa có thì gắn vào user có cùng email đã xác minh, hoặc tạo user mới.
-- API chỉ gọi SAU khi đã xác minh danh tính (đúng OTP / id_token hợp lệ). id mới (UUID v7) do API sinh.
create or replace function app_private.sign_in_identity(
  p_provider text, p_subject text, p_email text, p_new_user_id uuid, p_new_identity_id uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
begin
  select i.user_id into uid from public.auth_identities i
   where i.provider = p_provider and i.subject = p_subject;
  if uid is not null then
    return uid;
  end if;

  -- Hai lần đăng nhập đầu tiên đồng thời: on conflict + đọc lại thay vì lỗi unique.
  insert into public.users (id, email) values (p_new_user_id, p_email)
    on conflict (email) do nothing;
  select u.id into uid from public.users u where u.email = p_email;

  insert into public.auth_identities (id, user_id, provider, subject)
    values (p_new_identity_id, uid, p_provider, p_subject)
    on conflict (provider, subject) do nothing;
  select i.user_id into uid from public.auth_identities i
   where i.provider = p_provider and i.subject = p_subject;
  return uid;
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.sign_in_identity(text, text, text, uuid, uuid)
  from teachhub_worker, teachhub_readonly, public;
