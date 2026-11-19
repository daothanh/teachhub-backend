CREATE TABLE "center_waitlist" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"center_name" text NOT NULL,
	"teacher_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "center_waitlist_teacher_count_check" CHECK ("center_waitlist"."teacher_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "center_waitlist" ADD CONSTRAINT "center_waitlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "center_waitlist_user_id_idx" ON "center_waitlist" USING btree ("user_id");
--> statement-breakpoint

-- Dữ liệu của user, không thuộc tenant: user chỉ thấy và ghi bản đăng ký của chính mình (như idempotency_keys).
alter table center_waitlist enable row level security;
--> statement-breakpoint
alter table center_waitlist force row level security;
--> statement-breakpoint
create policy center_waitlist_self on center_waitlist for all to teachhub_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
