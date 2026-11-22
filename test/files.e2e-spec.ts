import { randomUUID } from 'node:crypto';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { startTestS3, type TestS3 } from './containers.js';
import { startTestApp, type TestApp } from './support/app.js';
import {
  familyFixture,
  JPEG,
  type Child,
  type Parent,
  type Teacher,
} from './support/family-fixture.js';

type UploadUrl = {
  fileId: string;
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  expiresAt: string;
};

// S8-BE files: presigned URL kho S3 (US-7.7, Spec §3.6c): quyền, loại, kích thước, HEAD khi complete, dọn tệp pending.
describe('files: presigned URL, complete, download-url', () => {
  let t: TestApp;
  let s3: TestS3;
  let s3c: S3Client;
  let appPool: pg.Pool;
  let f: ReturnType<typeof familyFixture>;
  let A: Teacher;
  let B: Teacher;
  let P1: Parent;
  let P2: Parent;
  let P3: Parent;
  let c1: Child; // con của P1 ở tenant A
  let c2: Child; // con của P2 ở tenant A
  let c3: Child; // con của P3 ở tenant B
  let inv1: string;
  let inv2: string;
  let inv3: string;

  const upload = (
    token: string,
    entityId: string,
    over: Record<string, unknown> = {},
    key?: string,
  ) =>
    f.call(
      token,
      'POST',
      '/files/upload-urls',
      {
        purpose: 'receipt',
        entityId,
        fileName: 'bien-lai.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 12,
        ...over,
      },
      key,
    );
  const put = (u: UploadUrl, body: Buffer | string, headers = u.headers) =>
    fetch(u.uploadUrl, {
      method: 'PUT',
      headers,
      body: typeof body === 'string' ? body : new Uint8Array(body),
    });
  const objectOf = async (fileId: string) =>
    (
      await f.q(`select bucket, object_key, status from files where id = $1`, [
        fileId,
      ])
    )[0] as { bucket: string; object_key: string; status: string };
  const head = async (key: string) => {
    try {
      return await s3c.send(
        new HeadObjectCommand({ Bucket: s3.env.S3_BUCKET_PRIVATE, Key: key }),
      );
    } catch {
      return null;
    }
  };
  const asUser = async <T>(
    userId: string,
    sql: string,
    args: unknown[] = [],
  ) => {
    const c = await appPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.user_id', $1, true)`, [userId]);
      const r = await c.query(sql, args);
      return { rows: r.rows as T[], rowCount: r.rowCount };
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  };

  beforeAll(async () => {
    s3 = await startTestS3();
    t = await startTestApp(s3.env);
    s3c = new S3Client({
      endpoint: s3.env.S3_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: s3.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: s3.env.S3_SECRET_ACCESS_KEY!,
      },
    });
    appPool = new pg.Pool({ connectionString: t.db.url('teachhub_app') });
    f = familyFixture(t);
    A = await f.mkTeacher('Cô Lan');
    B = await f.mkTeacher('Thầy Bình');
    [P1, P2, P3] = [await f.mkParent(), await f.mkParent(), await f.mkParent()];
    c1 = await f.child(A, P1);
    c2 = await f.child(A, P2, 'Trần Minh');
    c3 = await f.child(B, P3, 'Phạm Vy');
    [inv1, inv2, inv3] = [
      await f.invoice(c1),
      await f.invoice(c2),
      await f.invoice(c3),
    ];
  }, 240_000);
  // Mỗi ca bắt đầu không dính tệp pending của ca trước (giới hạn 5 pending mỗi người × hóa đơn).
  beforeEach(async () => {
    await f.q(`delete from files where status = 'pending'`);
  });
  afterAll(async () => {
    await appPool?.end();
    s3c?.destroy();
    await t?.stop();
    await s3?.container.stop();
  });

  it('luồng đủ: xin URL → PUT thẳng lên kho S3 → complete → tải về đúng nội dung; khóa không đoán được, tên gốc không vào khóa', async () => {
    const body = Buffer.concat([JPEG, Buffer.from('noi-dung-bien-lai-12345')]);
    const up = await upload(P1.token, inv1, {
      fileName: 'ảnh biên lai (1).jpg',
      sizeBytes: body.length,
    });
    expect(up.statusCode, up.body).toBe(201);
    const u = up.json() as UploadUrl;
    expect(u).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
    });
    expect(new URL(u.uploadUrl).searchParams.get('X-Amz-Expires')).toBe('120');
    expect(new Date(u.expiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + 121_000,
    );

    // Chưa tải lên: complete → 409; người xin URL mới được gọi.
    expect(
      (await f.call(P1.token, 'POST', `/files/${u.fileId}/complete`))
        .statusCode,
    ).toBe(409);
    expect((await put(u, body)).ok).toBe(true);
    for (const other of [P2.token, A.token])
      expect(
        (await f.call(other, 'POST', `/files/${u.fileId}/complete`)).statusCode,
      ).toBe(404);
    expect((await objectOf(u.fileId)).status).toBe('pending');

    const done = await f.call(P1.token, 'POST', `/files/${u.fileId}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({
      id: u.fileId,
      purpose: 'receipt',
      entityId: inv1,
      fileName: 'ảnh biên lai (1).jpg',
      mimeType: 'image/jpeg',
      sizeBytes: body.length,
      status: 'ready',
    });
    expect(Object.keys(done.json()).sort()).toEqual([
      'createdAt',
      'entityId',
      'fileName',
      'id',
      'mimeType',
      'purpose',
      'sizeBytes',
      'status',
    ]);
    // Gọi lại trên tệp ready vẫn 200.
    expect(
      (await f.call(P1.token, 'POST', `/files/${u.fileId}/complete`))
        .statusCode,
    ).toBe(200);

    const o = await objectOf(u.fileId);
    expect(o.object_key).toMatch(
      new RegExp(`^${A.tenantId}/receipts/${inv1}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(o.object_key).not.toContain('bien');
    expect(o.bucket).toBe(s3.env.S3_BUCKET_PRIVATE);

    const dl = await f.call(P1.token, 'GET', `/files/${u.fileId}/download-url`);
    expect(dl.statusCode, dl.body).toBe(200);
    const d = dl.json() as { url: string; expiresAt: string };
    expect(new URL(d.url).searchParams.get('X-Amz-Expires')).toBe('600');
    expect(
      Buffer.from(await (await fetch(d.url)).arrayBuffer()).toString(),
    ).toBe(body.toString());
    // Giáo viên của tenant sở hữu hóa đơn cũng xem được.
    expect(
      (await f.call(A.token, 'GET', `/files/${u.fileId}/download-url`))
        .statusCode,
    ).toBe(200);
  });

  it('loại và kích thước: MIME ngoài danh sách 422 FILE_TYPE_NOT_ALLOWED, quá 10 MB 422 FILE_TOO_LARGE, quá 20 MB 422 VALIDATION_FAILED; không có dòng files', async () => {
    const before = (await f.q(`select count(*)::int n from files`))[0].n;
    for (const mimeType of [
      'application/pdf',
      'text/html',
      'image/svg+xml',
      'image/gif',
    ]) {
      const r = await upload(P1.token, inv1, { mimeType });
      expect(r.statusCode, mimeType).toBe(422);
      expect(r.json().code).toBe('FILE_TYPE_NOT_ALLOWED');
    }
    const big = await upload(P1.token, inv1, { sizeBytes: 10_000_001 });
    expect(big.statusCode).toBe(422);
    expect(big.json().code).toBe('FILE_TOO_LARGE');
    expect(
      (await upload(P1.token, inv1, { sizeBytes: 10_000_000 })).statusCode,
    ).toBe(201);
    expect(
      (await upload(P1.token, inv1, { sizeBytes: 20_000_001 })).statusCode,
    ).toBe(422);
    expect((await upload(P1.token, inv1, { sizeBytes: 0 })).statusCode).toBe(
      422,
    );
    expect(
      (await upload(P1.token, inv1, { purpose: 'avatar' })).statusCode,
    ).toBe(422);
    expect((await f.q(`select count(*)::int n from files`))[0].n).toBe(
      before + 1,
    );
  });

  it('quyền thực thể: hóa đơn con người khác / tenant khác / nháp / không tồn tại / giáo viên xin → cùng 404; chưa đồng ý điều khoản → 403', async () => {
    const draft = await f.invoice(c1, { status: 'draft' });
    const cases: [string, string][] = [
      ['phụ huynh khác cùng tenant', (await upload(P1.token, inv2)).body],
      ['tenant khác', (await upload(P1.token, inv3)).body],
      ['nháp', (await upload(P1.token, draft)).body],
      ['không tồn tại', (await upload(P1.token, randomUUID())).body],
      ['giáo viên chủ hóa đơn', (await upload(A.token, inv1)).body],
      ['giáo viên tenant khác', (await upload(B.token, inv1)).body],
    ];
    for (const [name, body] of cases) {
      expect(JSON.parse(body).code, name).toBe('NOT_FOUND');
    }
    const noConsent = await f.mkParent(false);
    const c = await f.child(A, noConsent, 'Chưa đồng ý', false);
    const r = await upload(noConsent.token, await f.invoice(c));
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('CONSENT_REQUIRED');
    expect((await upload('rác', inv1)).statusCode).toBe(401);
  });

  it('Idempotency-Key: gọi lại cùng khóa trả cùng fileId và URL, khóa khác cho tệp mới', async () => {
    const key = randomUUID();
    const a = await upload(P1.token, inv1, {}, key);
    const b = await upload(P1.token, inv1, {}, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    const c = await upload(P1.token, inv1, {}, randomUUID());
    expect(c.json().fileId).not.toBe(a.json().fileId);
    expect(
      (await upload(P1.token, inv1, {}, 'khong-phai-uuid')).statusCode,
    ).toBe(422);
  });

  it('complete xác minh bằng HEAD: quá khai báo → 422 FILE_TOO_LARGE và xóa đối tượng; sai content-type → 422 FILE_TYPE_NOT_ALLOWED; nhỏ hơn khai báo → 422 VALIDATION_FAILED', async () => {
    const put2 = async (
      declared: number,
      send: Buffer,
      contentType: string,
    ) => {
      const u = (
        await upload(P1.token, inv1, { sizeBytes: declared })
      ).json() as UploadUrl;
      const o = await objectOf(u.fileId);
      // Ghi thẳng bằng khóa admin của kho để mô phỏng client tải sai khai báo (URL ký sẵn có thể từ chối trước).
      await s3c.send(
        new PutObjectCommand({
          Bucket: o.bucket,
          Key: o.object_key,
          Body: send,
          ContentType: contentType,
        }),
      );
      return { u, o };
    };
    const big = await put2(5, Buffer.alloc(9), 'image/jpeg');
    const r1 = await f.call(
      P1.token,
      'POST',
      `/files/${big.u.fileId}/complete`,
    );
    expect(r1.statusCode).toBe(422);
    expect(r1.json().code).toBe('FILE_TOO_LARGE');
    expect(await head(big.o.object_key)).toBeNull();
    expect((await objectOf(big.u.fileId)).status).toBe('pending');

    const wrong = await put2(5, Buffer.alloc(5), 'text/html');
    const r2 = await f.call(
      P1.token,
      'POST',
      `/files/${wrong.u.fileId}/complete`,
    );
    expect(r2.statusCode).toBe(422);
    expect(r2.json().code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(await head(wrong.o.object_key)).toBeNull();

    const small = await put2(9, Buffer.alloc(5), 'image/jpeg');
    const r3 = await f.call(
      P1.token,
      'POST',
      `/files/${small.u.fileId}/complete`,
    );
    expect(r3.statusCode).toBe(422);
    expect(r3.json().code).toBe('VALIDATION_FAILED');
    expect(await head(small.o.object_key)).toBeNull();
  });

  it('URL đã ký ràng buộc Content-Type và số byte: gửi khác loại hoặc nhiều hơn khai báo bị kho S3 từ chối chữ ký, không có đối tượng', async () => {
    const u = (await upload(P1.token, inv1)).json() as UploadUrl;
    const key = (await objectOf(u.fileId)).object_key;
    const badType = await put(u, 'x'.repeat(12), {
      'Content-Type': 'text/html',
    });
    expect(badType.status).toBe(403);
    const tooBig = await put(u, 'x'.repeat(5000));
    expect(tooBig.status).toBe(403);
    expect(await head(key)).toBeNull();
    expect((await put(u, 'x'.repeat(12))).ok).toBe(true);
  });

  it('download-url: tệp pending, phụ huynh khác, tenant khác, học sinh/không token đều không xem được', async () => {
    const id = await f.uploadReceipt(P1, inv1);
    const pending = (await upload(P1.token, inv1)).json() as UploadUrl;
    // pending: kể cả người tải lên cũng 404.
    expect(
      (await f.call(P1.token, 'GET', `/files/${pending.fileId}/download-url`))
        .statusCode,
    ).toBe(404);
    expect(
      (await f.call(A.token, 'GET', `/files/${pending.fileId}/download-url`))
        .statusCode,
    ).toBe(404);
    expect(
      (await f.call(P1.token, 'GET', `/files/${id}/download-url`)).statusCode,
    ).toBe(200);
    expect(
      (await f.call(A.token, 'GET', `/files/${id}/download-url`)).statusCode,
    ).toBe(200);
    for (const [name, token] of [
      ['phụ huynh khác cùng tenant', P2.token],
      ['phụ huynh tenant khác', P3.token],
      ['giáo viên tenant khác', B.token],
    ] as const) {
      const r = await f.call(token, 'GET', `/files/${id}/download-url`);
      expect(r.statusCode, name).toBe(404);
      expect(r.json().code, name).toBe('NOT_FOUND');
    }
    expect(
      (await f.call(P1.token, 'GET', `/files/${randomUUID()}/download-url`))
        .statusCode,
    ).toBe(404);
    expect(
      (await f.call(P1.token, 'GET', `/files/khong-phai-uuid/download-url`))
        .statusCode,
    ).toBe(422);
    expect(
      (await f.call(null, 'GET', `/files/${id}/download-url`)).statusCode,
    ).toBe(401);
    // Phụ huynh gỡ liên kết vẫn là người tải lên: giữ quyền xem biên lai của chính mình.
    // (Quyền theo người tải lên và nhân sự tenant, không theo liên kết hiện tại.)
  });

  it('RLS trực tiếp: phụ huynh khác 0 dòng; không tự chèn tệp cho hóa đơn của con người khác hay tenant khác; không xóa, không đổi trường định danh', async () => {
    const id = await f.uploadReceipt(P1, inv1);
    const seen = async (userId: string) =>
      (
        await asUser<{ n: number }>(
          userId,
          `select count(*)::int n from files where id = $1`,
          [id],
        )
      ).rows[0]!.n;
    expect(await seen(P1.userId)).toBe(1);
    expect(await seen(A.userId)).toBe(1);
    for (const who of [P2.userId, P3.userId, B.userId])
      expect(await seen(who)).toBe(0);

    const ins = (userId: string, tenantId: string, entityId: string) =>
      asUser(
        userId,
        `insert into files (id, tenant_id, owner_user_id, purpose, entity_id, bucket, object_key, original_name, mime, size_bytes)
         values (gen_random_uuid(), $2, $1, 'receipt', $3, 'b', gen_random_uuid()::text, 'x', 'image/jpeg', 5)`,
        [userId, tenantId, entityId],
      );
    await expect(ins(P2.userId, A.tenantId, inv1)).rejects.toThrow(
      /row-level security/,
    );
    await expect(ins(P1.userId, B.tenantId, inv3)).rejects.toThrow(
      /row-level security/,
    );
    await expect(ins(A.userId, A.tenantId, inv1)).rejects.toThrow(
      /row-level security/,
    );
    await expect(ins(P1.userId, A.tenantId, inv1)).resolves.toBeDefined();
    // Không xóa; không đổi `object_key` hay chủ.
    expect(
      (await asUser(P1.userId, `delete from files where id = $1`, [id]).catch(
        (e: Error) => e.message,
      )) as unknown,
    ).toMatch(/permission denied/);
    // Tệp ready không sửa được (policy chỉ cho đổi tệp pending): 0 dòng, kể cả đổi ngược về pending.
    expect(
      (
        await asUser(
          P1.userId,
          `update files set status = 'pending', ready_at = null where id = $1`,
          [id],
        )
      ).rowCount,
    ).toBe(0);
    // Tệp pending: trigger chặn đổi khóa đối tượng/chủ, chỉ cho pending → ready.
    const pending = (await upload(P1.token, inv1)).json() as UploadUrl;
    await expect(
      asUser(P1.userId, `update files set object_key = 'khac' where id = $1`, [
        pending.fileId,
      ]),
    ).rejects.toThrow(/FILE_IMMUTABLE/);
    expect(
      (
        await asUser(
          P1.userId,
          `update files set status = 'ready', ready_at = now() where id = $1`,
          [pending.fileId],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('job files.purge-pending: xóa pending quá 24 giờ (đối tượng + dòng), giữ pending mới và tệp ready; ghi job_runs', async () => {
    const { PurgePendingFilesJob } =
      await import('../libs/modules/files/application/purge-pending-files.job.js');
    const { ObjectStorage } =
      await import('../libs/infra/src/object-storage.js');
    const { JobRuns } = await import('../libs/infra/src/job-runs.js');
    const { TxService } = await import('../libs/db/src/tx.service.js');
    const schema = await import('../libs/db/src/schema/index.js');
    const tx = new TxService(
      drizzle(t.worker, { schema, casing: 'snake_case' }),
    );
    const job = new PurgePendingFilesJob(
      tx,
      new JobRuns(tx),
      t.app.get(ObjectStorage),
    );

    const mk = async (status: 'pending' | 'ready', ageHours: number) => {
      const fid = await f.dbFile({
        tenantId: A.tenantId,
        ownerUserId: P1.userId,
        entityId: inv1,
        status,
        ageHours,
        bucket: s3.env.S3_BUCKET_PRIVATE,
      });
      const key = (await objectOf(fid)).object_key;
      await s3c.send(
        new PutObjectCommand({
          Bucket: s3.env.S3_BUCKET_PRIVATE,
          Key: key,
          Body: 'x',
        }),
      );
      return { fid, key };
    };
    const stale = await mk('pending', 25);
    const fresh = await mk('pending', 1);
    const ready = await mk('ready', 48);
    const n = await job.run();
    expect(n).toBeGreaterThanOrEqual(1);
    const exists = async (id: string) =>
      (await f.q(`select 1 from files where id = $1`, [id])).length === 1;
    expect(await exists(stale.fid)).toBe(false);
    expect(await head(stale.key)).toBeNull();
    expect(await exists(fresh.fid)).toBe(true);
    expect(await head(fresh.key)).not.toBeNull();
    expect(await exists(ready.fid)).toBe(true);
    expect(await head(ready.key)).not.toBeNull();
    const [run] = await f.q(
      `select status, rows_affected from job_runs where job = 'files.purge-pending' order by started_at desc limit 1`,
    );
    expect(run).toMatchObject({ status: 'succeeded', rows_affected: n });
  });

  it('magic bytes: nội dung không phải JPEG/PNG/HEIC dù khai image/jpeg → 422 FILE_TYPE_NOT_ALLOWED và xóa đối tượng; PNG khai là JPEG cũng bị từ chối', async () => {
    const html = Buffer.from('<html><script>alert(1)</script>');
    const u = (
      await upload(P1.token, inv1, { sizeBytes: html.length })
    ).json() as UploadUrl;
    expect((await put(u, html)).ok).toBe(true);
    const r = await f.call(P1.token, 'POST', `/files/${u.fileId}/complete`);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(await head((await objectOf(u.fileId)).object_key)).toBeNull();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
    ]);
    const u2 = (
      await upload(P1.token, inv1, { sizeBytes: png.length })
    ).json() as UploadUrl;
    expect((await put(u2, png)).ok).toBe(true);
    expect(
      (await f.call(P1.token, 'POST', `/files/${u2.fileId}/complete`))
        .statusCode,
    ).toBe(422);
  });

  it('tối đa 5 tệp pending mỗi (người tải, hóa đơn): thứ 6 → 429 RATE_LIMITED, hóa đơn khác và người khác không bị ảnh hưởng; complete trả chỗ', async () => {
    const mine = await f.invoice(c1);
    for (let i = 0; i < 5; i++)
      expect((await upload(P1.token, mine)).statusCode).toBe(201);
    const over = await upload(P1.token, mine);
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('RATE_LIMITED');
    expect((await upload(P1.token, inv1)).statusCode).toBe(201);
    await f.q(
      `update files set status = 'ready', ready_at = now() where entity_id = $1 and id = (select id from files where entity_id = $1 limit 1)`,
      [mine],
    );
    expect((await upload(P1.token, mine)).statusCode).toBe(201);
  });

  it('complete từ chối tệp pending quá 24 giờ → 409 CONFLICT_STALE', async () => {
    const body = JPEG;
    const u = (
      await upload(P1.token, inv1, { sizeBytes: body.length })
    ).json() as UploadUrl;
    expect((await put(u, body)).ok).toBe(true);
    await f.q(
      `update files set created_at = now() - interval '25 hours' where id = $1`,
      [u.fileId],
    );
    const r = await f.call(P1.token, 'POST', `/files/${u.fileId}/complete`);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('CONFLICT_STALE');
  });

  it('complete lưu ETag; etag bất biến sau ready', async () => {
    const id = await f.uploadReceipt(P1, inv1);
    const [row] = await f.q(`select etag from files where id = $1`, [id]);
    expect(row.etag).toMatch(/^"?[0-9a-f]{32}/);
    await expect(
      f.q(`update files set etag = 'khac' where id = $1`, [id]),
    ).rejects.toThrow(/FILE_IMMUTABLE/);
  });
});
