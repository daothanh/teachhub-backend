// @teachhub/core nạp ConfigModule (kiểm env) ngay khi import → đặt env tối thiểu trước.
vi.hoisted(() =>
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://a@b/c',
    REDIS_URL: 'redis://a',
    S3_REGION: 'x',
    S3_ACCESS_KEY_ID: 'x',
    S3_SECRET_ACCESS_KEY: 'x',
    S3_BUCKET_PRIVATE: 'x',
  }),
);

import { createAdjustmentRequestSchema } from './billing.schemas.js';

describe('createAdjustmentRequestSchema', () => {
  const base = {
    description: 'Tài liệu',
    adjustmentReason: 'Phụ thu tài liệu',
  };

  it('mặc định manual_adjustment, nhận số âm', () => {
    expect(
      createAdjustmentRequestSchema.parse({ ...base, amount: -100_000 }),
    ).toMatchObject({ kind: 'manual_adjustment', amount: -100_000 });
  });

  it('surcharge dương hợp lệ', () => {
    expect(
      createAdjustmentRequestSchema.parse({
        ...base,
        amount: 50_000,
        kind: 'surcharge',
      }),
    ).toMatchObject({ kind: 'surcharge', amount: 50_000 });
  });

  it('surcharge âm → lỗi ở trường amount', () => {
    const r = createAdjustmentRequestSchema.safeParse({
      ...base,
      amount: -50_000,
      kind: 'surcharge',
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path)).toEqual([['amount']]);
  });
});
