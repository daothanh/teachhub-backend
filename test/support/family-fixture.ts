import { randomUUID } from 'node:crypto';
import type { TestApp } from './app.js';
import { seedTenant, type SeededTenant } from './seed.js';

export type Teacher = SeededTenant & { token: string };
export type Parent = { userId: string; token: string };
export type Child = { studentId: string; guardianId: string; who: Teacher };

const TERMS = '2026-12-01';

/**
 * Dựng giáo viên, phụ huynh liên kết qua lời mời thật, hóa đơn đã phát hành, tệp biên lai (qua API + kho S3 thật hoặc dòng DB)
 * cho e2e của `files` và `payment_claims` (S8-BE). Mọi truy vấn dựng dữ liệu đi qua role worker (BYPASSRLS).
 */
export function familyFixture(t: TestApp) {
  let seq = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await t.worker.query(sql, params)).rows;
  const call = (
    token: string | null,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    key: string | null = method === 'POST' ? randomUUID() : null,
  ) =>
    t.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
    });

  const mkTeacher = async (name: string): Promise<Teacher> => {
    const s = await seedTenant(t.worker);
    await q(`update users set display_name = $2 where id = $1`, [
      s.userId,
      name,
    ]);
    return { ...s, token: await t.tokenFor(s.userId) };
  };
  const mkParent = async (
    consent = true,
    name = 'Phụ huynh',
  ): Promise<Parent> => {
    const userId = randomUUID();
    await q(`insert into users (id, email, display_name) values ($1, $2, $3)`, [
      userId,
      `${userId}@example.com`,
      name,
    ]);
    const token = await t.tokenFor(userId);
    if (consent) {
      await call(token, 'POST', '/consents', {
        role: 'parent',
        termsVersion: TERMS,
      });
    }
    return { userId, token };
  };
  /** Học viên của `who` liên kết với phụ huynh `p` qua lời mời thật. */
  const child = async (
    who: Teacher,
    p: Parent,
    fullName = 'Lê Gia Bảo',
    /** `false`: nối thẳng qua DB (phụ huynh chưa đồng ý điều khoản không nhận được lời mời). */
    viaInvite = true,
  ): Promise<Child> => {
    seq++;
    const st = await call(who.token, 'POST', '/students', {
      fullName,
      dob: `2012-${String(1 + (seq % 12)).padStart(2, '0')}-${String(1 + (seq % 27)).padStart(2, '0')}`,
      guardians: [
        { fullName: 'Lê Văn A', relation: 'father', phone: '0912345678' },
      ],
    });
    if (st.statusCode !== 201) throw new Error(`tạo học viên: ${st.body}`);
    const s = st.json() as { id: string; guardians: { id: string }[] };
    if (!viaInvite) {
      await q(`update guardians set user_id = $1 where id = $2`, [
        p.userId,
        s.guardians[0]!.id,
      ]);
      await q(
        `insert into memberships (id, user_id, role) values ($1, $2, 'parent')`,
        [randomUUID(), p.userId],
      );
      return { studentId: s.id, guardianId: s.guardians[0]!.id, who };
    }
    const inv = await call(who.token, 'POST', `/students/${s.id}/invites`, {
      guardianId: s.guardians[0]!.id,
    });
    const acc = await call(p.token, 'POST', '/invites/accept', {
      token: inv.json().token,
    });
    if (acc.statusCode !== 200) throw new Error(`nhận lời mời: ${acc.body}`);
    return { studentId: s.id, guardianId: s.guardians[0]!.id, who };
  };
  /** Hóa đơn của `c` (kỳ riêng); `status` mặc định đã phát hành (dựng thẳng qua DB). */
  const invoice = async (
    c: { studentId: string; who: Teacher },
    o: { status?: 'draft' | 'issued' | 'void'; total?: number } = {},
  ) => {
    seq++;
    const status = o.status ?? 'issued';
    const periodId = randomUUID();
    const id = randomUUID();
    const month = `${2060 + Math.floor(seq / 12)}-${String((seq % 12) + 1).padStart(2, '0')}-01`;
    await q(
      `insert into billing_periods (id, tenant_id, period_month, close_date, due_date) values ($1, $2, $3, $3, ($3::date + 9))`,
      [periodId, c.who.tenantId, month],
    );
    await q(
      `insert into invoices (id, tenant_id, period_id, student_id, total_amount) values ($1, $2, $3, $4, $5)`,
      [id, c.who.tenantId, periodId, c.studentId, o.total ?? 1_200_000],
    );
    if (status !== 'draft') {
      const code = `TH-${String(100000 + seq)}`;
      await q(
        `update invoices set status = 'issued', code = $2, transfer_note = $3, qr_payload = $4,
           payout = '{"bankBin":"970436","bankName":"Vietcombank","accountNo":"0011001234567","accountName":"NGUYEN VAN A"}'::jsonb,
           issued_at = now() - interval '1 day' where id = $1`,
        [id, code, code.replace('-', ' '), `000201-${code}`],
      );
    }
    if (status === 'void')
      await q(
        `update invoices set status = 'void', void_reason = 'nhầm', voided_at = now() where id = $1`,
        [id],
      );
    return id;
  };
  /** Dòng `files` dựng thẳng (không có đối tượng trong kho S3): cho test không cần tải thật. */
  const dbFile = async (o: {
    tenantId: string;
    ownerUserId: string;
    entityId: string;
    status?: 'pending' | 'ready';
    ageHours?: number;
    bucket?: string;
  }) => {
    const id = randomUUID();
    await q(
      `insert into files (id, tenant_id, owner_user_id, purpose, entity_id, bucket, object_key, original_name, mime, size_bytes, status, created_at, ready_at)
       values ($1, $2, $3, 'receipt', $4, $9, $5, 'bien-lai.jpg', 'image/jpeg', 1000, $6, now() - make_interval(hours => $7), $8)`,
      [
        id,
        o.tenantId,
        o.ownerUserId,
        o.entityId,
        `${o.tenantId}/receipts/${o.entityId}/${id}.jpg`,
        o.status ?? 'ready',
        o.ageHours ?? 0,
        (o.status ?? 'ready') === 'ready' ? new Date() : null,
        o.bucket ?? 'x',
      ],
    );
    return id;
  };
  /** Tải biên lai thật: upload-urls → PUT lên kho S3 → complete. Trả id tệp `ready`. */
  const uploadReceipt = async (
    p: Parent,
    invoiceId: string,
    body: Buffer = Buffer.from('anh-bien-lai'),
  ): Promise<string> => {
    const up = await call(p.token, 'POST', '/files/upload-urls', {
      purpose: 'receipt',
      entityId: invoiceId,
      fileName: 'bien-lai.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: body.length,
    });
    if (up.statusCode !== 201) throw new Error(`upload-urls: ${up.body}`);
    const u = up.json() as {
      fileId: string;
      uploadUrl: string;
      headers: Record<string, string>;
    };
    const put = await fetch(u.uploadUrl, {
      method: 'PUT',
      headers: u.headers,
      body: new Uint8Array(body),
    });
    if (!put.ok) throw new Error(`PUT kho S3: ${put.status}`);
    const done = await call(p.token, 'POST', `/files/${u.fileId}/complete`);
    if (done.statusCode !== 200) throw new Error(`complete: ${done.body}`);
    return u.fileId;
  };
  return {
    q,
    call,
    mkTeacher,
    mkParent,
    child,
    invoice,
    dbFile,
    uploadReceipt,
  };
}
