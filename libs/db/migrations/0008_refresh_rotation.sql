-- Xoay vòng refresh token (S1-BE-05, Technical Spec §2.7, D20). Lúc làm mới chưa biết user (chỉ có token)
-- nên RLS theo app.user_id trả 0 dòng → làm trong một hàm security definer, khóa dòng để hai lần làm mới
-- cùng token không cùng thắng.

create policy refresh_tokens_owner_all on refresh_tokens for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint

-- status: 'ok' (kèm user_id, session_id) | 'invalid' | 'reused' (đã thu hồi cả họ) | 'expired'.
-- Hạn trượt 30 ngày, không quá 90 ngày tính từ lần đăng nhập mở họ token.
create or replace function app_private.rotate_refresh_token(p_hash text, p_new_id uuid, p_new_hash text)
returns table (status text, user_id uuid, session_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  r public.refresh_tokens%rowtype;
  family_start timestamptz;
begin
  select * into r from public.refresh_tokens t where t.token_hash = p_hash for update;
  if not found then
    return query select 'invalid', null::uuid, null::uuid;
    return;
  end if;
  if r.revoked_at is not null then
    -- Token đã xoay/thu hồi lại được dùng → có thể bị đánh cắp: thu hồi cả họ.
    update public.refresh_tokens t set revoked_at = now()
     where t.family_id = r.family_id and t.revoked_at is null;
    return query select 'reused', r.user_id, r.session_id;
    return;
  end if;
  select min(t.created_at) into family_start from public.refresh_tokens t where t.family_id = r.family_id;
  if r.expires_at <= now() or family_start + interval '90 days' <= now() then
    update public.refresh_tokens t set revoked_at = now()
     where t.family_id = r.family_id and t.revoked_at is null;
    return query select 'expired', r.user_id, r.session_id;
    return;
  end if;

  insert into public.refresh_tokens (id, user_id, session_id, family_id, token_hash, device_info, expires_at)
  values (p_new_id, r.user_id, r.session_id, r.family_id, p_new_hash, r.device_info,
          least(now() + interval '30 days', family_start + interval '90 days'));
  update public.refresh_tokens t set revoked_at = now(), replaced_by = p_new_id where t.id = r.id;
  return query select 'ok', r.user_id, r.session_id;
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.rotate_refresh_token(text, uuid, text)
  from teachhub_worker, teachhub_readonly, public;
