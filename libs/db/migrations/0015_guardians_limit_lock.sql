-- Trigger giới hạn 2 phụ huynh: khóa dòng học viên bằng FOR NO KEY UPDATE thay vì FOR UPDATE. Vẫn tuần tự hóa hai
-- lần thêm song song (hai khóa này xung đột nhau) nhưng không chặn insert vào bảng con có FK trỏ tới học viên
-- (ghi danh), vì FK chỉ cần FOR KEY SHARE.
create or replace function app_private.guardians_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is null then
    perform 1 from public.students where id = new.student_id for no key update;
    if (select count(*) from public.guardians
         where student_id = new.student_id and deleted_at is null and id <> new.id) >= 2 then
      raise exception 'student % đã có 2 phụ huynh', new.student_id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
