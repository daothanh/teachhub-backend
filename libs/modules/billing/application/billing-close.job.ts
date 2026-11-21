import { Injectable, Logger } from '@nestjs/common';
import {
  and,
  between,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { MAX_VND, uuidv7 } from '@teachhub/core';
import {
  attendance,
  billingPeriods,
  classes,
  enrollments,
  invoiceLines,
  invoices,
  recordOutboxEvent,
  scheduleRules,
  studentStatusHistory,
  sessions,
  students,
  tenants,
  TxService,
  type Tx,
} from '@teachhub/db';
import { JobRuns } from '@teachhub/infra';
import {
  generateSessions,
  localDate,
  MAX_HORIZON_DAYS,
} from '@teachhub/modules/schedule';
import {
  type ClassFee,
  type ClassSession,
  computeEnrollmentInvoice,
  type PeriodDates,
  parseBillingSettings,
  closablePeriods,
  type StatusChange,
  studentPeriodState,
} from '../domain/billing-period.js';
import { minuteOfDay, minutesUntilSendWindow } from '../domain/dunning.js';
import {
  planCarryOver,
  prevAdjustmentDescription,
} from '../domain/carry-over.js';
import type { FeeType } from '../domain/invoice-calculator.js';
import {
  loadCarryState,
  loadPrevAdjustments,
  newLine,
} from './carry-over.queries.js';

export const JOB_BILLING_CLOSE = 'billing.close';
/** Tên sự kiện outbox báo giáo viên bản nháp đã sẵn sàng (Technical Spec §3). */
export const BILLING_DRAFTS_READY = 'billing_drafts_ready';
export interface BillingDraftsReadyPayload extends Record<string, unknown> {
  periodId: string;
  periodMonth: string;
  draftCount: number;
  draftTotalAmount: number;
}

interface ReadyPeriod {
  periodId: string;
  periodMonth: string;
  count: number;
  total: number;
}
interface ClosedPeriod {
  draftCount: number;
  /** Nháp chốt được của kỳ (để gộp thông báo), null = không có. */
  ready: ReadyPeriod | null;
}
const NONE: ClosedPeriod = { draftCount: 0, ready: null };

const LINE_CHUNK = 1000;
/** Mã lỗi Postgres (vd. 23505) của lỗi gốc, hoặc tên lỗi: không log message (có thể chứa dữ liệu học viên). */
const errorCode = (e: unknown): string => {
  const base = e instanceof Error ? (e.cause ?? e) : e;
  const code = (base as { code?: unknown }).code;
  return typeof code === 'string' ? code : ((base as Error)?.name ?? 'unknown');
};

/**
 * Job 02:00 tạo kỳ thu và bản nháp hóa đơn (S5-BE-05, US-7.2 AC1). Chạy bằng role worker (BYPASSRLS) nên mọi truy vấn
 * lọc `tenant_id` tường minh; "hôm nay" theo múi giờ từng tenant. Mỗi tenant một giao dịch (kỳ, hóa đơn, dòng, outbox
 * cùng commit); tenant lỗi không chặn tenant khác, có lỗi thì job ghi `failed` và ném lại để BullMQ thử lại.
 *
 * Idempotent: kỳ upsert theo (tenant, tháng) rồi khóa dòng kỳ và kiểm lại dưới khóa; học viên đã có hóa đơn nào trong kỳ (nháp, đã phát
 * hành hay đã hủy) thì bỏ qua; `invoices_draft_uq` là lớp chặn cuối. Chạy lại cùng ngày không tạo gì mới và không ghi outbox.
 *
 * Quy tắc kỳ, học viên tạm nghỉ/đã rời, buổi chưa điểm danh: xem đầu `domain/billing-period.ts` (D1–D5).
 */
@Injectable()
export class BillingCloseJob {
  private readonly log = new Logger(BillingCloseJob.name);
  /** Đồng hồ thật (khác `now` của cron); test ghi đè. */
  clock: () => Date = () => new Date();

  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
  ) {}

  /**
   * Trả số bản nháp đã tạo. `now` do cron cố định theo thời điểm tạo job để lần BullMQ thử lại vẫn tính đúng kỳ.
   */
  run(now = new Date()): Promise<number> {
    return this.runs.track(JOB_BILLING_CLOSE, async () => {
      const tenantRows = await this.tx.run({ userId: null }, (t) =>
        t
          .select({
            id: tenants.id,
            tz: tenants.timezone,
            settings: tenants.settings,
          })
          .from(tenants)
          .where(isNull(tenants.deletedAt)),
      );
      let created = 0;
      let failed = 0;
      for (const tenant of tenantRows) {
        try {
          created += await this.tx.run({ userId: null }, async (t) => {
            const [last] = await t
              .select({ m: max(billingPeriods.periodMonth) })
              .from(billingPeriods)
              .where(eq(billingPeriods.tenantId, tenant.id));
            // Catch-up: mọi kỳ đã tới ngày chốt mà chưa có, cũ → mới, cùng một giao dịch (idempotent: chạy lại không có kỳ thiếu).
            let n = 0;
            const ready: ReadyPeriod[] = [];
            for (const period of closablePeriods(
              localDate(now, tenant.tz),
              parseBillingSettings(tenant.settings),
              last?.m ?? null,
            )) {
              const r = await this.closeTenant(t, tenant.id, tenant.tz, period);
              n += r.draftCount;
              if (r.ready) ready.push(r.ready);
            }
            await this.notifyReady(t, tenant.id, tenant.tz, ready);
            return n;
          });
        } catch (e) {
          failed += 1;
          this.log.error(`tenant ${tenant.id}: ${errorCode(e)}`);
        }
      }
      if (failed) throw new Error(`${failed} tenant không tạo được bản nháp`);
      return created;
    });
  }

  /**
   * MỘT sự kiện `billing_drafts_ready` cho cả lần chạy của tenant (catch-up nhiều kỳ không bắn mỗi kỳ một push): `periodId`/`periodMonth` là kỳ
   * mới nhất có nháp chốt được, `draftCount`/`draftTotalAmount` cộng các kỳ. Giờ yên lặng (Spec §6.7): job chạy 02:00 nên hẹn tới 07:00 giờ
   * tenant (ngoài khung 07:00–21:30 thì tới 07:00 kế tiếp) qua `next_attempt_at` của outbox, tính từ giờ chạy THẬT (`clock`), không từ
   * `job.timestamp` (lần BullMQ thử lại muộn không bị hẹn vào quá khứ/sai khung). Một sự kiện, một thông báo (khóa theo eventId): không gửi trùng.
   */
  private async notifyReady(
    t: Tx,
    tenantId: string,
    tz: string,
    ready: ReadyPeriod[],
  ): Promise<void> {
    const latest = ready.at(-1);
    if (!latest) return;
    const payload: BillingDraftsReadyPayload = {
      periodId: latest.periodId,
      periodMonth: latest.periodMonth,
      draftCount: ready.reduce((n, r) => n + r.count, 0),
      draftTotalAmount: ready.reduce((n, r) => n + r.total, 0),
    };
    const wall = this.clock();
    const waitMin = minutesUntilSendWindow(minuteOfDay(wall, tz));
    await recordOutboxEvent(t, {
      tenantId,
      type: BILLING_DRAFTS_READY,
      payload,
      ...(waitMin && {
        deliverAt: new Date(wall.getTime() + waitMin * 60_000),
      }),
    });
  }

  /**
   * Ngày các buổi của từng lớp trọn khóa theo cấu hình (US-7.1 AC5). Lớp không đủ cấu hình (không ngày kết thúc, chưa có quy tắc lặp,
   * khóa dài hơn mốc sinh buổi) vắng mặt trong kết quả và được cảnh báo: hóa đơn dùng shortcut đếm buổi hiện có.
   */
  private async loadCourseDates(
    t: Tx,
    tenantId: string,
    tz: string,
    courses: (typeof classes.$inferSelect)[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!courses.length) return out;
    const rules = await t
      .select({
        classId: scheduleRules.classId,
        id: scheduleRules.id,
        weekday: scheduleRules.weekday,
        startTime: scheduleRules.startTime,
        durationMin: scheduleRules.durationMin,
      })
      .from(scheduleRules)
      .where(
        and(
          eq(scheduleRules.tenantId, tenantId),
          inArray(
            scheduleRules.classId,
            courses.map((c) => c.id),
          ),
        ),
      );
    for (const c of courses) {
      const own = rules
        .filter((r) => r.classId === c.id)
        .map((r) => ({ ...r, startTime: r.startTime.slice(0, 5) }));
      const days = c.endDate
        ? (Date.parse(`${c.endDate}T00:00:00Z`) -
            Date.parse(`${c.startDate}T00:00:00Z`)) /
            86_400_000 +
          1
        : Infinity;
      if (!own.length || days > MAX_HORIZON_DAYS) {
        this.log.warn(
          `tenant ${tenantId} lớp ${c.id}: trọn khóa thiếu cấu hình tổng buổi (cần ngày kết thúc ≤ ${MAX_HORIZON_DAYS} ngày và quy tắc lặp), dùng số buổi hiện có`,
        );
        continue;
      }
      out.set(
        c.id,
        generateSessions(own, {
          classStart: c.startDate,
          classEnd: c.endDate,
          today: c.startDate,
          tz,
        }).map((g) => g.sessionDate),
      );
    }
    return out;
  }

  /**
   * Một kỳ của tenant trong giao dịch của `run`; trả số bản nháp mới và nháp chốt được. Kỳ đã có thì chỉ chạy lại đúng ngày chốt (bù học viên mới);
   * lỡ ngày chốt thì kỳ chưa có vẫn được tạo ở lần chạy sau (catch-up, `run` gọi từng kỳ cũ → mới). Kỳ chỉ được tạo khi có bản nháp.
   */
  private async closeTenant(
    t: Tx,
    tenantId: string,
    tz: string,
    period: PeriodDates,
  ): Promise<ClosedPeriod> {
    const periodWhere = and(
      eq(billingPeriods.tenantId, tenantId),
      eq(billingPeriods.periodMonth, period.periodMonth),
    );
    const [known] = await t.select().from(billingPeriods).where(periodWhere);
    if (known && !period.isCloseDay) return NONE;

    const classRows = await t
      .select()
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), isNotNull(classes.feeType)));
    if (!classRows.length) return NONE;
    const classIds = classRows.map((c) => c.id);
    const courseIds = classRows
      .filter((c) => c.feeType === 'course')
      .map((c) => c.id);

    const enrollmentRows = await t
      .select({
        classId: enrollments.classId,
        studentId: enrollments.studentId,
        joinedOn: enrollments.joinedOn,
        leftOn: enrollments.leftOn,
        feeOverride: enrollments.feeOverride,
        status: students.status,
      })
      .from(enrollments)
      .innerJoin(
        students,
        and(
          eq(students.tenantId, enrollments.tenantId),
          eq(students.id, enrollments.studentId),
        ),
      )
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          inArray(enrollments.classId, classIds),
          lte(enrollments.joinedOn, period.periodEnd),
          or(
            isNull(enrollments.leftOn),
            gt(enrollments.leftOn, period.periodMonth),
          ),
        ),
      );
    if (!enrollmentRows.length) return NONE;

    // Lịch sử đổi trạng thái để xét học viên theo kỳ (D4): ngày đổi theo giờ tenant, cũ → mới.
    const history = new Map<string, StatusChange[]>();
    const studentIds = [...new Set(enrollmentRows.map((r) => r.studentId))];
    for (let i = 0; i < studentIds.length; i += 5000) {
      const rows = await t
        .select({
          studentId: studentStatusHistory.studentId,
          from: studentStatusHistory.fromStatus,
          to: studentStatusHistory.toStatus,
          at: studentStatusHistory.changedAt,
        })
        .from(studentStatusHistory)
        .where(
          and(
            eq(studentStatusHistory.tenantId, tenantId),
            inArray(
              studentStatusHistory.studentId,
              studentIds.slice(i, i + 5000),
            ),
          ),
        )
        .orderBy(studentStatusHistory.changedAt, studentStatusHistory.id);
      for (const r of rows) {
        const list = history.get(r.studentId) ?? [];
        list.push({ from: r.from, to: r.to, on: localDate(r.at, tz) });
        history.set(r.studentId, list);
      }
    }

    const invoicedStudents = async (periodId: string) =>
      new Set(
        (
          await t
            .select({ studentId: invoices.studentId })
            .from(invoices)
            .where(
              and(
                eq(invoices.tenantId, tenantId),
                eq(invoices.periodId, periodId),
              ),
            )
        ).map((r) => r.studentId),
      );
    const existing = known
      ? await invoicedStudents(known.id)
      : new Set<string>();

    // Lớp trọn khóa cần mọi buổi (đếm tổng và còn lại); lớp khác chỉ cần buổi trong tháng của kỳ.
    const sessionRows = await t
      .select({
        id: sessions.id,
        classId: sessions.classId,
        date: sessions.sessionDate,
        status: sessions.status,
        isMakeup: sessions.isMakeup,
        makeupOf: sessions.makeupOf,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          inArray(sessions.classId, classIds),
          courseIds.length
            ? or(
                inArray(sessions.classId, courseIds),
                between(
                  sessions.sessionDate,
                  period.periodMonth,
                  period.periodEnd,
                ),
              )
            : between(
                sessions.sessionDate,
                period.periodMonth,
                period.periodEnd,
              ),
        ),
      );
    const sessionsByClass = new Map<string, ClassSession[]>();
    const dateOf = new Map<string, string>();
    for (const s of sessionRows) {
      dateOf.set(s.id, s.date);
      const list = sessionsByClass.get(s.classId) ?? [];
      list.push({ ...s, status: s.status as ClassSession['status'] });
      sessionsByClass.set(s.classId, list);
    }

    // Điểm danh của các buổi trong kỳ, theo học viên.
    const periodSessionIds = sessionRows
      .filter((s) => s.date >= period.periodMonth && s.date <= period.periodEnd)
      .map((s) => s.id);
    const attByStudent = new Map<string, Map<string, string>>();
    for (let i = 0; i < periodSessionIds.length; i += 5000) {
      const rows = await t
        .select({
          studentId: attendance.studentId,
          sessionId: attendance.sessionId,
          status: attendance.status,
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.tenantId, tenantId),
            inArray(attendance.sessionId, periodSessionIds.slice(i, i + 5000)),
          ),
        );
      for (const r of rows) {
        const m = attByStudent.get(r.studentId) ?? new Map<string, string>();
        m.set(r.sessionId, r.status);
        attByStudent.set(r.studentId, m);
      }
    }

    // Trọn khóa: tổng buổi theo cấu hình lớp (quy tắc lặp trong [ngày bắt đầu, ngày kết thúc]); lớp thiếu cấu hình dùng shortcut đếm buổi.
    const courseDates = await this.loadCourseDates(
      t,
      tenantId,
      tz,
      classRows.filter((c) => c.feeType === 'course'),
    );

    // Gộp mọi lớp của một học viên thành một hóa đơn (lớp theo tên cho thứ tự dòng ổn định).
    const classById = new Map(classRows.map((c) => [c.id, c]));
    type Draft = {
      studentId: string;
      lines: (typeof invoiceLines.$inferInsert)[];
      total: number;
      courses: { no: number; count: number }[];
    };
    const drafts = new Map<string, Draft>();
    const ordered = [...enrollmentRows].sort(
      (a, b) =>
        (classById.get(a.classId)?.name ?? '').localeCompare(
          classById.get(b.classId)?.name ?? '',
        ) || a.studentId.localeCompare(b.studentId),
    );
    for (const row of ordered) {
      if (existing.has(row.studentId)) continue;
      const c = classById.get(row.classId);
      if (!c) continue;
      // D4: trạng thái học viên theo kỳ (mốc đổi tính theo ngày địa phương của tenant).
      const state = studentPeriodState(
        row.status,
        history.get(row.studentId) ?? [],
        period.periodEnd,
      );
      if (!state || (state.leftOn && state.leftOn <= period.periodMonth))
        continue;
      const enr = {
        ...row,
        leftOn:
          state.leftOn && (!row.leftOn || state.leftOn < row.leftOn)
            ? state.leftOn
            : row.leftOn,
      };
      const fee: ClassFee = {
        className: c.name,
        feeType: c.feeType as FeeType,
        feeAmount: c.feeAmount!,
        feeRules: c.feeRules,
        courseDates: courseDates.get(c.id) ?? null,
      };
      const r = computeEnrollmentInvoice(
        fee,
        enr,
        period,
        sessionsByClass.get(c.id) ?? [],
        attByStudent.get(enr.studentId) ?? new Map(),
        { paused: state.paused },
      );
      if (!r || !r.result.lines.length) continue;
      const d = drafts.get(enr.studentId) ?? {
        studentId: enr.studentId,
        lines: [],
        total: 0,
        courses: [],
      };
      for (const l of r.result.lines) {
        d.lines.push({
          id: uuidv7(),
          tenantId,
          invoiceId: '', // gán khi có id hóa đơn
          position: d.lines.length + 1,
          kind: l.kind,
          description: l.description,
          amount: l.amount,
          charged: l.charged ?? true,
          notChargedReason:
            l.kind === 'session' && l.charged === false ? l.reason! : null,
          sessionId: l.sessionId ?? null,
          sessionDate: l.sessionId ? (dateOf.get(l.sessionId) ?? null) : null,
          className: c.name,
          adjustmentReason: null,
        });
      }
      // Tổng = Σ dòng thô của mọi ghi danh, cắt ở mức hóa đơn (cùng công thức với xem trước, `adjust` và `issue`).
      d.total += r.result.lines.reduce((n, l) => n + l.amount, 0);
      if (r.installmentNo && r.installmentCount)
        d.courses.push({ no: r.installmentNo, count: r.installmentCount });
      drafts.set(enr.studentId, d);
    }
    if (!drafts.size) return NONE;

    // Từ đây ghi: tạo kỳ nếu chưa có rồi khóa dòng kỳ để hai lần chạy chồng nhau nối tiếp nhau, và kiểm lại học viên đã có
    // hóa đơn dưới khóa.
    await t
      .insert(billingPeriods)
      .values({
        id: uuidv7(),
        tenantId,
        periodMonth: period.periodMonth,
        closeDate: period.closeDate,
        dueDate: period.dueDate,
      })
      .onConflictDoNothing();
    const [bp] = await t
      .select()
      .from(billingPeriods)
      .where(periodWhere)
      .for('update');
    if (!bp) throw new Error('không tạo được kỳ thu');
    const invoiced = await invoicedStudents(bp.id);

    let draftCount = 0;
    let readyCount = 0;
    let readyTotalAmount = 0;
    const lineRows: (typeof invoiceLines.$inferInsert)[] = [];
    const todo = [...drafts.values()].filter((d) => !invoiced.has(d.studentId));
    const todoIds = todo.map((d) => d.studentId);
    const prevAdj = await loadPrevAdjustments(
      t,
      tenantId,
      period.periodMonth,
      todoIds,
      classById,
    );
    // Dòng `carry_over` ở bản nháp chỉ là XEM TRƯỚC: không ghi sổ, không đụng hóa đơn cũ. Kết chuyển thật ở `issue()` (D6).
    const carry = await loadCarryState(
      t,
      tenantId,
      todoIds,
      period.periodMonth,
    );
    for (const d of todo) {
      if (d.total > MAX_VND) {
        // Một hóa đơn vượt trần không được làm hỏng cả tenant mỗi đêm: bỏ qua, chỉ log mã lỗi và id học viên.
        this.log.error(
          `tenant ${tenantId} học viên ${d.studentId}: TOTAL_EXCEEDS_CAP`,
        );
        continue;
      }
      const adjustments = prevAdj.get(d.studentId) ?? [];
      const preview = carry.get(d.studentId)?.carry ?? 0;
      const plan = planCarryOver(
        d.total + adjustments.reduce((n, a) => n + a.amount, 0),
        preview,
      );
      if (plan.total > MAX_VND) {
        this.log.error(
          `tenant ${tenantId} học viên ${d.studentId}: TOTAL_EXCEEDS_CAP`,
        );
        continue;
      }
      const id = uuidv7();
      // Thông tin đợt chỉ ghi khi hóa đơn có đúng một lớp trọn khóa.
      const course = d.courses.length === 1 ? d.courses[0]! : null;
      const [row] = await t
        .insert(invoices)
        .values({
          id,
          tenantId,
          periodId: bp.id,
          studentId: d.studentId,
          totalAmount: plan.total,
          clampedAmount: plan.clamped,
          installmentNo: course?.no ?? null,
          installmentCount: course?.count ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: invoices.id });
      if (!row) continue; // đã có bản nháp (chạy chồng): bỏ qua
      draftCount += 1;
      // Chỉ nháp chốt được (có khoản phát sinh ≠ 0) tính vào thông báo "bản nháp sẵn sàng".
      if (plan.issuable) {
        readyCount += 1;
        readyTotalAmount += plan.total;
      }
      let position = d.lines.length;
      for (const l of d.lines) lineRows.push({ ...l, invoiceId: id });
      const extra = (
        kind: string,
        description: string,
        amount: number,
        more: Partial<typeof invoiceLines.$inferInsert> = {},
      ) =>
        lineRows.push(
          newLine(tenantId, id, ++position, kind, description, amount, more),
        );
      if (preview)
        extra(
          'carry_over',
          preview > 0 ? 'Nợ kỳ trước' : 'Trả thừa kỳ trước',
          preview,
        );
      for (const a of adjustments)
        extra('prev_adjustment', prevAdjustmentDescription(a), a.amount, {
          sessionId: a.sessionId,
          sessionDate: a.date || null,
          className: a.className,
        });
    }
    for (let i = 0; i < lineRows.length; i += LINE_CHUNK)
      await t.insert(invoiceLines).values(lineRows.slice(i, i + LINE_CHUNK));
    if (!draftCount) return NONE;

    // Kỳ đã `closed` mà có bản nháp chốt được mới (học viên vào muộn) thì quay lại `drafting`.
    if (bp.status === 'closed' && readyCount > 0)
      await t
        .update(billingPeriods)
        .set({ status: 'drafting' })
        .where(
          and(
            eq(billingPeriods.tenantId, tenantId),
            eq(billingPeriods.id, bp.id),
          ),
        );

    // Gộp thông báo ở `run`: một lần chạy catch-up chỉ một sự kiện cho cả tenant.
    return {
      draftCount,
      ready: readyCount
        ? {
            periodId: bp.id,
            periodMonth: bp.periodMonth,
            count: readyCount,
            total: readyTotalAmount,
          }
        : null,
    };
  }
}
