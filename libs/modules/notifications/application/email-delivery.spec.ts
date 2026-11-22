import { describe, expect, it, vi } from 'vitest';
import { deliverEmail } from './email-delivery.js';

// @teachhub/core nạp CoreModule (đọc env lúc import): chỉ cần uuidv7.
vi.mock('@teachhub/core', () => ({ uuidv7: () => 'id' }));

/** Giả lập TxService: mỗi `execute` trả lần lượt `rows` theo thứ tự câu lệnh. */
const make = (results: unknown[][]) => {
  const execute = vi.fn();
  for (const rows of results) execute.mockResolvedValueOnce({ rows });
  execute.mockResolvedValue({ rows: [] });
  const tx = {
    run: (_ctx: unknown, fn: (t: unknown) => unknown) => fn({ execute }),
  };
  const mailer = { send: vi.fn().mockResolvedValue(undefined) };
  const log = { error: vi.fn() };
  const deps = { tx, mailer, log } as never;
  return {
    execute,
    mailer,
    run: () => deliverEmail(deps, 'n1', 'a@b.c', 'tiêu đề', 'nội dung'),
  };
};

describe('deliverEmail: nhận dòng idempotent', () => {
  it('nhận được dòng mới → gửi và trả true', async () => {
    const { mailer, run } = make([[{ id: 'd' }]]);
    expect(await run()).toBe(true);
    expect(mailer.send).toHaveBeenCalledOnce();
  });

  it('không nhận được, dòng đã sent → true, không gửi lại', async () => {
    const { mailer, run } = make([[], [], [{ status: 'sent' }]]);
    expect(await run()).toBe(true);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('không nhận được, dòng queued chưa quá hạn → false để BullMQ thử lại', async () => {
    const { mailer, run } = make([[], [], [{ status: 'queued' }]]);
    expect(await run()).toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('gửi lỗi → false', async () => {
    const { mailer, run } = make([[{ id: 'd' }]]);
    mailer.send.mockRejectedValueOnce(new Error('x'));
    expect(await run()).toBe(false);
  });
});
