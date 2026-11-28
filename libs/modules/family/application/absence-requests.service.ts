import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '@teachhub/core';
import { type Tx, TxService } from '@teachhub/db';
import { ConsentsService } from '@teachhub/modules/identity';
import { formatInZone } from '@teachhub/modules/schedule';
import {
  canCancelAbsence,
  checkReportable,
} from '../domain/absence-request.js';
import type {
  AbsenceRequest,
  AbsenceRequestList,
  CreateAbsenceRequest,
} from '../http/family.schemas.js';

type Row = {
  id: string;
  session_id: string;
  student_id: string;
  class_id: string;
  class_name: string;
  starts_at: Date | string;
  reason: AbsenceRequest['reason'];
  note: string | null;
  created_at: Date | string;
  cancelled_at: Date | string | null;
  timezone: string;
};

const toRequest = (r: Row): AbsenceRequest => ({
  id: r.id,
  sessionId: r.session_id,
  studentId: r.student_id,
  classId: r.class_id,
  className: r.class_name,
  sessionStartsAt: formatInZone(new Date(r.starts_at), r.timezone),
  reason: r.reason,
  note: r.note,
  reportedAt: formatInZone(new Date(r.created_at), r.timezone),
});

/**
 * Phụ huynh báo vắng trước (US-3.4). Phụ huynh không đọc/ghi được buổi, ghi danh hay bảng `absence_requests`: mọi đường đi qua
 * hàm CSDL security definer lọc theo `linked_student_ids()` (user từ `app.user_id`), KHÔNG theo `ctx.tenantId`. Luật thời gian ở
 * `domain/absence-request.ts` quyết lỗi trả về; hàm ghi kiểm lại giờ trong cùng giao dịch làm nguồn cuối. Con không liên kết,
 * buổi tenant khác, con không thuộc lớp của buổi, báo vắng của người khác → cùng 404, không lộ tồn tại. Không log ghi chú.
 */
@Injectable()
export class AbsenceRequestsService {
  constructor(
    private readonly tx: TxService,
    private readonly consents: ConsentsService,
  ) {}

  async create(
    t: Tx,
    userId: string,
    body: CreateAbsenceRequest,
    now = new Date(),
  ): Promise<{ created: boolean; request: AbsenceRequest }> {
    await this.consents.assertAccepted(userId, 'parent');
    const s = (
      await t.execute<{ starts_at: Date | string; session_status: string }>(
        sql`select * from app_private.family_absence_session(${body.studentId}::uuid, ${body.sessionId}::uuid)`,
      )
    ).rows[0];
    if (!s) throw new AppException('NOT_FOUND');
    this.assertReportable(
      checkReportable(
        { status: s.session_status, startsAt: new Date(s.starts_at) },
        now,
      ),
    );
    const r = (
      await t.execute<{
        r: {
          result: 'ok' | 'not_found' | 'cancelled' | 'started';
          id?: string;
          created?: boolean;
        };
      }>(sql`select app_private.create_absence_request(${body.sessionId}::uuid, ${body.studentId}::uuid,
        ${body.reason}::text, ${body.note ?? null}::text) as r`)
    ).rows[0]!.r;
    if (r.result === 'not_found') throw new AppException('NOT_FOUND');
    if (r.result !== 'ok') this.assertReportable(r.result);
    const row = await this.find(t, r.id!);
    return { created: r.created === true, request: toRequest(row!) };
  }

  async list(userId: string, studentId: string): Promise<AbsenceRequestList> {
    await this.consents.assertAccepted(userId, 'parent');
    return this.tx.run({ userId }, async (t) => {
      const linked = await t.execute(
        sql`select 1 from app_private.linked_student_ids() x where x = ${studentId}::uuid`,
      );
      if (!linked.rows.length) throw new AppException('NOT_FOUND');
      const rows = (
        await t.execute<Row>(
          sql`select * from app_private.family_absence_requests(${studentId}::uuid, null, true)`,
        )
      ).rows;
      return { items: rows.map(toRequest) };
    });
  }

  async cancel(userId: string, id: string, now = new Date()): Promise<void> {
    await this.consents.assertAccepted(userId, 'parent');
    await this.tx.run({ userId }, async (t) => {
      const row = await this.find(t, id);
      if (!row) throw new AppException('NOT_FOUND');
      if (row.cancelled_at) return; // idempotent
      if (!canCancelAbsence(new Date(row.starts_at), now))
        throw new AppException('ABSENCE_SESSION_STARTED');
      const res = (
        await t.execute<{ r: 'ok' | 'not_found' | 'started' }>(
          sql`select app_private.cancel_absence_request(${id}::uuid) as r`,
        )
      ).rows[0]!.r;
      if (res === 'not_found') throw new AppException('NOT_FOUND');
      if (res === 'started') throw new AppException('ABSENCE_SESSION_STARTED');
    });
  }

  private async find(t: Tx, id: string): Promise<Row | undefined> {
    return (
      await t.execute<Row>(
        sql`select * from app_private.family_absence_requests(null, ${id}::uuid, false)`,
      )
    ).rows[0];
  }

  private assertReportable(gate: 'ok' | 'cancelled' | 'started'): void {
    if (gate === 'cancelled') throw new AppException('SESSION_CANCELLED');
    if (gate === 'started') throw new AppException('ABSENCE_SESSION_STARTED');
  }
}
