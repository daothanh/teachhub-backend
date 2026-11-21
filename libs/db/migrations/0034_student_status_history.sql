CREATE TABLE "student_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_status_history_status_check" CHECK ("student_status_history"."from_status" in ('active', 'paused', 'left') and "student_status_history"."to_status" in ('active', 'paused', 'left') and "student_status_history"."from_status" <> "student_status_history"."to_status")
);
--> statement-breakpoint
ALTER TABLE "student_status_history" ADD CONSTRAINT "student_status_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_status_history" ADD CONSTRAINT "student_status_history_tenant_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_status_history_student_idx" ON "student_status_history" USING btree ("tenant_id","student_id","changed_at");
--> statement-breakpoint
-- Lịch sử đổi trạng thái học viên cho billing xét học viên theo kỳ (issue #179). RLS như `students`; chỉ trigger ghi.
alter table student_status_history enable row level security;
--> statement-breakpoint
alter table student_status_history force row level security;
--> statement-breakpoint
create policy student_status_history_staff_all on student_status_history for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy student_status_history_owner_all on student_status_history for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
-- Security definer: học viên bị đổi trạng thái bởi vai trò nào cũng ghi được lịch sử, không phụ thuộc policy của người gọi.
create or replace function app_private.students_status_history() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    -- clock_timestamp(): hai lần đổi trong cùng giao dịch vẫn có thứ tự (now() trả cùng một giờ).
    insert into public.student_status_history (id, tenant_id, student_id, from_status, to_status, changed_at)
    values (gen_random_uuid(), new.tenant_id, new.id, old.status, new.status, clock_timestamp());
  end if;
  return null;
end;
$$;
--> statement-breakpoint
create trigger trg_students_status_history after update of status on students
  for each row execute function app_private.students_status_history();
