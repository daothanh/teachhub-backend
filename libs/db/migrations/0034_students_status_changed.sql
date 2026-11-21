ALTER TABLE "students" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "status_before" text;
--> statement-breakpoint
-- Ghi lúc đổi `status` và trạng thái trước đó để billing xét học viên theo kỳ (issue #179). Học viên đã `paused`/`left`
-- trước migration này không có mốc (NULL): billing giữ cách cũ cho họ (xét theo trạng thái hiện tại).
create or replace function app_private.students_status_changed() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
    new.status_before := old.status;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger trg_students_status_changed before update of status on students
  for each row execute function app_private.students_status_changed();
