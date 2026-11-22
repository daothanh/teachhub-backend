CREATE TABLE "payment_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"receipt_file_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" bigint NOT NULL,
	"note" text,
	"claimed_by" uuid NOT NULL,
	"claimed_by_name" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolved_by_name" text,
	"reject_reason" text,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_claims_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_claims_status_check" CHECK ("payment_claims"."status" in ('pending', 'confirmed', 'rejected')),
	CONSTRAINT "payment_claims_amount_check" CHECK ("payment_claims"."amount" > 0 and "payment_claims"."amount" <= 100000000000),
	CONSTRAINT "payment_claims_note_check" CHECK (char_length("payment_claims"."note") <= 300),
	CONSTRAINT "payment_claims_resolved_check" CHECK (("payment_claims"."status" = 'pending') = ("payment_claims"."resolved_at" is null)
        and ("payment_claims"."resolved_at" is null) = ("payment_claims"."resolved_by" is null)
        and ("payment_claims"."resolved_at" is null) = ("payment_claims"."resolved_by_name" is null)
        and ("payment_claims"."status" = 'confirmed') = ("payment_claims"."payment_id" is not null)
        and ("payment_claims"."status" = 'rejected') = ("payment_claims"."reject_reason" is not null)
        and ("payment_claims"."reject_reason" is null or char_length("payment_claims"."reject_reason") between 1 and 300))
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "files_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "files_object_key_uq" UNIQUE("bucket","object_key"),
	CONSTRAINT "files_purpose_check" CHECK ("files"."purpose" in ('receipt')),
	CONSTRAINT "files_status_check" CHECK ("files"."status" in ('pending', 'ready')),
	CONSTRAINT "files_ready_check" CHECK (("files"."status" = 'ready') = ("files"."ready_at" is not null)),
	CONSTRAINT "files_size_check" CHECK ("files"."size_bytes" between 1 and 20000000),
	CONSTRAINT "files_name_check" CHECK (char_length("files"."original_name") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "dunning_jobs" DROP CONSTRAINT "dunning_jobs_cancel_reason_check";--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_tenant_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_tenant_file_fk" FOREIGN KEY ("tenant_id","receipt_file_id") REFERENCES "public"."files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_tenant_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_claims_pending_uq" ON "payment_claims" USING btree ("invoice_id") WHERE "payment_claims"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_claims_receipt_uq" ON "payment_claims" USING btree ("receipt_file_id");--> statement-breakpoint
CREATE INDEX "payment_claims_invoice_idx" ON "payment_claims" USING btree ("tenant_id","invoice_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_claims_claimed_by_idx" ON "payment_claims" USING btree ("claimed_by");--> statement-breakpoint
CREATE INDEX "payment_claims_resolved_by_idx" ON "payment_claims" USING btree ("resolved_by") WHERE "payment_claims"."resolved_by" is not null;--> statement-breakpoint
CREATE INDEX "files_entity_idx" ON "files" USING btree ("tenant_id","purpose","entity_id");--> statement-breakpoint
CREATE INDEX "files_owner_idx" ON "files" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "files_pending_idx" ON "files" USING btree ("created_at") WHERE "files"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "dunning_jobs" ADD CONSTRAINT "dunning_jobs_cancel_reason_check" CHECK (("dunning_jobs"."status" = 'cancelled') = ("dunning_jobs"."cancel_reason" is not null)
        and ("dunning_jobs"."cancel_reason" is null or "dunning_jobs"."cancel_reason" in ('settled', 'void', 'student_disabled', 'tenant_disabled', 'superseded', 'claim_pending')));
--> statement-breakpoint
-- S8-BE files + payment_claims (US-7.7). Chỉ thêm bảng; ràng buộc `dunning_jobs_cancel_reason_check` mở thêm lý do `claim_pending`
-- (lời nhắc tạm dừng vì hóa đơn chờ giáo viên xác nhận, lập lại khi bị từ chối). Bảng nhỏ, khóa ngắn.

-- ===== files: nhân sự tenant đọc; người tải lên đọc/đổi `pending → ready` và (phụ huynh) tạo bản ghi cho hóa đơn của con mình.
-- Không ai xóa qua role app/readonly: job dọn `pending` chạy role worker (BYPASSRLS). `tenant_id` do server lấy từ hóa đơn.
alter table files enable row level security;
--> statement-breakpoint
alter table files force row level security;
--> statement-breakpoint
create policy files_staff_read on files for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy files_uploader_read on files for select to teachhub_app
  using (owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
-- Biên lai: chỉ tạo cho hóa đơn đã phát hành của con còn học đã liên kết (cùng điều kiện `GET /family/invoices/{id}`), luôn `pending`.
create policy files_receipt_insert on files for insert to teachhub_app
  with check (
    owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and purpose = 'receipt' and status = 'pending'
    and exists (
      select 1 from invoices i
       where i.tenant_id = files.tenant_id and i.id = files.entity_id and i.status <> 'draft'
         and i.student_id in (select fs.student_id from app_private.family_students() fs)));
--> statement-breakpoint
create policy files_uploader_update on files for update to teachhub_app
  using (owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid and status = 'pending')
  with check (owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
create policy files_owner_all on files for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
revoke delete, truncate on files from teachhub_app, teachhub_readonly;
--> statement-breakpoint
-- Trường định danh bất biến sau khi tạo (chỉ đổi status/ready_at); chạy bằng quyền người gọi.
create or replace function app_private.files_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.owner_user_id is distinct from old.owner_user_id or new.purpose is distinct from old.purpose
     or new.entity_id is distinct from old.entity_id or new.bucket is distinct from old.bucket
     or new.object_key is distinct from old.object_key or new.mime is distinct from old.mime
     or new.size_bytes is distinct from old.size_bytes or new.original_name is distinct from old.original_name
     or (old.status = 'ready' and new.status <> 'ready') then
    raise exception 'FILE_IMMUTABLE: tệp chỉ được chuyển pending → ready' using errcode = '42501';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger trg_files_guard before update on files for each row execute function app_private.files_guard();
--> statement-breakpoint

-- ===== payment_claims: nhân sự tenant đọc, chủ tenant xử lý (đúng controller `tenant_owner`), người báo đọc lần báo của mình.
-- Ghi (tạo) chỉ qua app_private.create_payment_claim vì phải đổi hóa đơn và nhắc nợ mà phụ huynh không có quyền.
alter table payment_claims enable row level security;
--> statement-breakpoint
alter table payment_claims force row level security;
--> statement-breakpoint
create policy payment_claims_staff_read on payment_claims for select to teachhub_app
  using (tenant_id in (select app_private.staff_tenant_ids()));
--> statement-breakpoint
create policy payment_claims_claimant_read on payment_claims for select to teachhub_app
  using (claimed_by = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
create policy payment_claims_owner_update on payment_claims for update to teachhub_app
  using (tenant_id in (select app_private.owner_tenant_ids()))
  with check (tenant_id in (select app_private.owner_tenant_ids())
    and (resolved_by is null or resolved_by = nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
create policy payment_claims_owner_all on payment_claims for all to teachhub_owner using (true) with check (true);
--> statement-breakpoint
revoke delete, truncate on payment_claims from teachhub_app, teachhub_worker, teachhub_readonly;
--> statement-breakpoint
create trigger trg_payment_claims_updated_at before update on payment_claims
  for each row execute function app_private.set_updated_at();
--> statement-breakpoint
-- Lần báo đã xử lý là chứng từ: chỉ được chuyển `pending → confirmed/rejected` một lần, mọi cột còn lại bất biến.
create or replace function app_private.payment_claims_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
       old.status <> 'pending'
    or new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
    or new.invoice_id is distinct from old.invoice_id or new.receipt_file_id is distinct from old.receipt_file_id
    or new.amount is distinct from old.amount or new.note is distinct from old.note
    or new.claimed_by is distinct from old.claimed_by or new.claimed_by_name is distinct from old.claimed_by_name
    or new.created_at is distinct from old.created_at) then
    raise exception 'PAYMENT_CLAIM_IMMUTABLE: lần báo chỉ được xử lý một lần' using errcode = '42501';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger trg_payment_claims_guard before update on payment_claims
  for each row execute function app_private.payment_claims_guard();
--> statement-breakpoint
select app_private.enable_audit('payment_claims');
--> statement-breakpoint

-- Hàm security definer chạy bằng teachhub_owner, bị FORCE RLS: cần policy cho owner ở bảng nó đụng tới (cùng cách 0029, 0031, 0034).
create policy invoices_definer_read on invoices for select to teachhub_owner using (true);
--> statement-breakpoint
create policy invoices_definer_update on invoices for update to teachhub_owner using (true) with check (true);
--> statement-breakpoint
create policy dunning_jobs_definer_read on dunning_jobs for select to teachhub_owner using (true);
--> statement-breakpoint
create policy dunning_jobs_definer_update on dunning_jobs for update to teachhub_owner using (true) with check (true);
--> statement-breakpoint

-- Phụ huynh báo đã chuyển khoản (US-7.7 AC1). Một giao dịch: khóa hóa đơn → kiểm quyền, trạng thái, tệp → ghi lần báo `pending`,
-- hóa đơn `issued`/`partially_paid` → `pending_confirmation`, hủy mốc nhắc nợ chưa gửi (`claim_pending`), outbox `payment_claim_created`,
-- audit hóa đơn (lần báo có trigger audit riêng). Người gọi lấy từ `app.user_id`; phụ huynh phải là người giám hộ còn hiệu lực của
-- con còn học (như `/family/invoices`). Trả jsonb {result: ok | not_found | not_payable | pending_exists | bad_file, ...}.
create or replace function app_private.create_payment_claim(p_invoice_id uuid, p_file_id uuid, p_amount bigint, p_note text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  inv public.invoices; f public.files; c public.payment_claims;
  remaining bigint; uname text; tz text;
begin
  if uid is null then
    raise exception 'create_payment_claim: cần người dùng đăng nhập' using errcode = '42501';
  end if;
  select i.* into inv from public.invoices i
   where i.id = p_invoice_id and i.status <> 'draft'
     and i.student_id in (select fs.student_id from app_private.family_students() fs)
   for update of i;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if inv.status in ('void', 'paid') then return jsonb_build_object('result', 'not_payable'); end if;
  if inv.status = 'pending_confirmation'
     or exists (select 1 from public.payment_claims x where x.invoice_id = inv.id and x.status = 'pending') then
    return jsonb_build_object('result', 'pending_exists');
  end if;
  remaining := inv.total_amount - inv.paid_amount - inv.carried_amount;
  if remaining <= 0 then return jsonb_build_object('result', 'not_payable'); end if;

  select * into f from public.files x where x.id = p_file_id and x.tenant_id = inv.tenant_id;
  if not found or f.owner_user_id <> uid or f.purpose <> 'receipt' or f.entity_id <> inv.id or f.status <> 'ready'
     or exists (select 1 from public.payment_claims x where x.receipt_file_id = f.id) then
    return jsonb_build_object('result', 'bad_file');
  end if;

  select coalesce(display_name, '') into uname from public.users where id = uid;
  select timezone into tz from public.tenants where id = inv.tenant_id;
  begin
    insert into public.payment_claims (id, tenant_id, invoice_id, receipt_file_id, status, amount, note, claimed_by, claimed_by_name)
    values (gen_random_uuid(), inv.tenant_id, inv.id, f.id, 'pending', coalesce(p_amount, remaining), nullif(p_note, ''), uid, coalesce(uname, ''))
    returning * into c;
  exception when unique_violation then
    -- Hai request song song cùng hóa đơn: chỉ một lần báo `pending`.
    return jsonb_build_object('result', 'pending_exists');
  end;
  update public.invoices set status = 'pending_confirmation' where id = inv.id;
  update public.dunning_jobs set status = 'cancelled', cancel_reason = 'claim_pending'
   where tenant_id = inv.tenant_id and invoice_id = inv.id and status = 'pending';
  insert into public.outbox_events (id, tenant_id, type, payload)
    values (gen_random_uuid(), inv.tenant_id, 'payment_claim_created', jsonb_build_object('claimId', c.id, 'invoiceId', inv.id));
  perform app_private.audit_insert(inv.tenant_id, 'invoice', inv.id, 'update',
    jsonb_build_object('status', inv.status, 'paidAmount', inv.paid_amount),
    jsonb_build_object('status', 'pending_confirmation', 'paidAmount', inv.paid_amount, 'paymentClaimId', c.id));
  return jsonb_build_object('result', 'ok', 'claimId', c.id, 'timezone', coalesce(tz, 'Asia/Ho_Chi_Minh'));
end;
$$;
--> statement-breakpoint
revoke execute on function app_private.create_payment_claim(uuid, uuid, bigint, text) from teachhub_worker, teachhub_readonly, public;
