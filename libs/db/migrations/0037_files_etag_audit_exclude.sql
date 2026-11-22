ALTER TABLE "files" ADD COLUMN "etag" text;
--> statement-breakpoint
-- Review bảo mật S8: (1) `etag` do `complete` ghi cùng lúc chuyển `ready`, bất biến sau đó.
create or replace function app_private.files_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.owner_user_id is distinct from old.owner_user_id or new.purpose is distinct from old.purpose
     or new.entity_id is distinct from old.entity_id or new.bucket is distinct from old.bucket
     or new.object_key is distinct from old.object_key or new.mime is distinct from old.mime
     or new.size_bytes is distinct from old.size_bytes or new.original_name is distinct from old.original_name
     or (old.status = 'ready' and (new.status <> 'ready' or new.etag is distinct from old.etag)) then
    raise exception 'FILE_IMMUTABLE: tệp chỉ được chuyển pending → ready' using errcode = '42501';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
-- (2) Trigger audit tổng quát nhận danh sách cột loại trừ qua tham số trigger (TG_ARGV), ngoài `phone`/`email`.
create or replace function app_private.audit_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  excluded text[] := coalesce(tg_argv, '{}'::text[]);
  old_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - 'phone' - 'email' - excluded end;
  new_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - 'phone' - 'email' - excluded end;
  row_data jsonb := coalesce(new_row, old_row);
begin
  if tg_op = 'UPDATE' then
    if to_jsonb(old) = to_jsonb(new) then
      return null;
    end if;
    if old_row = new_row then
      new_row := new_row || jsonb_build_object('redacted_changed', true);
    end if;
  end if;
  perform app_private.audit_insert(
    (row_data ->> 'tenant_id')::uuid,
    tg_table_name,
    (row_data ->> 'id')::uuid,
    lower(tg_op),
    old_row,
    new_row
  );
  return null;
end;
$$;
--> statement-breakpoint
-- `payment_claims`: ghi chú, lý do từ chối (văn bản tự do) và tên người báo không vào audit_logs.
drop trigger trg_payment_claims_audit on payment_claims;
--> statement-breakpoint
create trigger trg_payment_claims_audit after insert or update or delete on payment_claims
  for each row execute function app_private.audit_trigger('note', 'reject_reason', 'claimed_by_name', 'resolved_by_name');
