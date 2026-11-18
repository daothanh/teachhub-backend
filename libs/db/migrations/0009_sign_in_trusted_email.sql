-- SSO (S1-BE-06): chỉ gộp vào user có sẵn theo email khi nhà cung cấp có thẩm quyền với email đó
-- (Google: @gmail.com, @googlemail.com, hoặc tên miền Workspace `hd`). Email OTP luôn có thẩm quyền
-- (đã chứng minh giữ hộp thư). Không có thẩm quyền mà email đã thuộc user khác → trả null, API từ chối.

drop function app_private.sign_in_identity(text, text, text, uuid, uuid);
--> statement-breakpoint
create function app_private.sign_in_identity(
  p_provider text, p_subject text, p_email text, p_new_user_id uuid, p_new_identity_id uuid,
  p_link_by_email boolean default true
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
  if uid <> p_new_user_id and not p_link_by_email then
    return null;
  end if;

  insert into public.auth_identities (id, user_id, provider, subject)
    values (p_new_identity_id, uid, p_provider, p_subject)
    on conflict (provider, subject) do nothing;
  select i.user_id into uid from public.auth_identities i
   where i.provider = p_provider and i.subject = p_subject;
  return uid;
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.sign_in_identity(text, text, text, uuid, uuid, boolean)
  from teachhub_worker, teachhub_readonly, public;
