-- unaccent() chỉ STABLE nên không dùng được trong cột generated; bọc lại thành IMMUTABLE với từ điển cố định.
create or replace function app_private.f_unaccent(text) returns text
language sql immutable parallel safe strict set search_path = '' as $$
  select public.unaccent('public.unaccent'::regdictionary, $1)
$$;
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"joined_on" date NOT NULL,
	"left_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_left_on_check" CHECK ("enrollments"."left_on" is null or "enrollments"."left_on" >= "enrollments"."joined_on")
);
--> statement-breakpoint
CREATE TABLE "guardians" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"relation" text DEFAULT 'guardian' NOT NULL,
	"phone" text,
	"email" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "guardians_relation_check" CHECK ("guardians"."relation" in ('father', 'mother', 'guardian'))
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"full_name_unaccent" text GENERATED ALWAYS AS (lower(app_private.f_unaccent(full_name))) STORED,
	"dob" date,
	"school" text,
	"school_class" text,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"status_effective_on" date,
	"left_reason" text,
	"is_readonly" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "students_status_check" CHECK ("students"."status" in ('active', 'paused', 'left'))
);
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_tenant_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_tenant_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_tenant_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_open_uq" ON "enrollments" USING btree ("class_id","student_id") WHERE "enrollments"."left_on" is null;--> statement-breakpoint
CREATE INDEX "enrollments_student_id_idx" ON "enrollments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "guardians_student_id_idx" ON "guardians" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "guardians_user_id_idx" ON "guardians" USING btree ("user_id") WHERE "guardians"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "students_tenant_status_idx" ON "students" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "students_full_name_unaccent_trgm_idx" ON "students" USING gin ("full_name_unaccent" gin_trgm_ops);
--> statement-breakpoint

-- Tối đa 2 phụ huynh chưa gỡ cho mỗi học viên (Spec §4.4). Dòng học viên bị khóa để hai lần thêm song song
-- không cùng vượt giới hạn.
-- Chạy quyền người gọi (không security definer): FORCE RLS cũng áp cho owner nên bản definer sẽ thấy 0 dòng.
create or replace function app_private.guardians_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is null then
    perform 1 from public.students where id = new.student_id for update;
    if (select count(*) from public.guardians
         where student_id = new.student_id and deleted_at is null and id <> new.id) >= 2 then
      raise exception 'student % đã có 2 phụ huynh', new.student_id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger trg_guardians_limit before insert or update of deleted_at, student_id on guardians
  for each row execute function app_private.guardians_limit();
--> statement-breakpoint

-- RLS: nhân sự tenant đọc/ghi dữ liệu tenant mình. Quyền đọc của phụ huynh (linked_student_ids) thêm cùng US-6.x.
alter table students enable row level security;
--> statement-breakpoint
alter table students force row level security;
--> statement-breakpoint
create policy students_staff_all on students for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create trigger trg_students_updated_at before update on students
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
alter table guardians enable row level security;
--> statement-breakpoint
alter table guardians force row level security;
--> statement-breakpoint
create policy guardians_staff_all on guardians for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create trigger trg_guardians_updated_at before update on guardians
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
alter table enrollments enable row level security;
--> statement-breakpoint
alter table enrollments force row level security;
--> statement-breakpoint
create policy enrollments_staff_all on enrollments for all to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()))
  with check (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create trigger trg_enrollments_updated_at before update on enrollments
  for each row execute function app_private.set_updated_at();
