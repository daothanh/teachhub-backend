import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { AppException, type Env } from '@teachhub/core';
import {
  bankTransferOrders,
  classes,
  planFeatures,
  plans,
  students,
  subscriptions,
  tenantFeatureOverrides,
  type Tx,
} from '@teachhub/db';
import {
  daysLeft,
  effectiveStatus,
  exceedsLimit,
  overLimit,
  planCodeOf,
  type PlanCode,
  type SubscriptionStatus,
} from '../domain/plan.js';
import type {
  PlanUsage,
  SubscriptionBankTransferOrder,
} from '../http/subscription.schemas.js';

type Limits = {
  max_active_classes: number | null;
  max_active_students: number | null;
};
type OrderRow = typeof bankTransferOrders.$inferSelect;

export function toOrder(r: OrderRow): SubscriptionBankTransferOrder {
  return {
    id: r.id,
    planCode: r.planCode as 'pro',
    amount: r.amount,
    transferNote: r.transferNote,
    payee: r.payee as SubscriptionBankTransferOrder['payee'],
    qrPayload: r.qrPayload,
    status: r.status as 'pending' | 'confirmed',
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Nguồn sự thật duy nhất về gói của tenant (US-0.7, US-0.8): `subscriptions` + `plans.limits` + `plan_features`.
 * `plan-usage` và hạn mức 402 ở `POST /classes`, `POST /students` đều đọc qua đây.
 */
@Injectable()
export class PlanService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private async load(tx: Tx, tenantId: string, now: Date) {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId));
    if (!sub) throw new AppException('INTERNAL_ERROR');
    const status = effectiveStatus(
      {
        status: sub.status as SubscriptionStatus,
        currentPeriodEnd: sub.currentPeriodEnd,
      },
      now,
    );
    const code = planCodeOf(status);
    const [plan] = await tx.select().from(plans).where(eq(plans.code, code));
    if (!plan) throw new AppException('INTERNAL_ERROR');
    return { sub, status, code, limits: plan.limits as Limits };
  }

  private async activeCounts(tx: Tx, tenantId: string) {
    const [c] = await tx
      .select({ n: count() })
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), eq(classes.status, 'active')));
    const [s] = await tx
      .select({ n: count() })
      .from(students)
      .where(
        and(eq(students.tenantId, tenantId), eq(students.status, 'active')),
      );
    return { classes: c?.n ?? 0, students: s?.n ?? 0 };
  }

  /** Chặn tạo thêm lớp/học sinh vượt giới hạn gói (US-0.7 AC1, AC2, AC4): 402 `PLAN_LIMIT_EXCEEDED`. */
  async assertCanAdd(
    tx: Tx,
    tenantId: string,
    kind: 'classes' | 'students',
    adding = 1,
  ): Promise<void> {
    // Hai request song song của cùng tenant nối đuôi nhau, nếu không cả hai cùng đếm thấy còn chỗ.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'plan-limit:' + tenantId}, 0))`,
    );
    const { limits } = await this.load(tx, tenantId, new Date());
    const feature =
      kind === 'classes' ? 'max_active_classes' : 'max_active_students';
    const limit = limits[feature];
    if (limit === null) return;
    const current = (await this.activeCounts(tx, tenantId))[kind];
    if (exceedsLimit(current, adding, limit))
      throw new AppException('PLAN_LIMIT_EXCEEDED', {
        limit,
        current,
        attempted: adding,
        feature,
      });
  }

  /** Feature flag hiệu lực: cờ theo gói, tenant ghi đè (US-0.7 AC4). Khóa không có dòng nào coi là tắt. */
  private async featureMap(
    tx: Tx,
    tenantId: string,
    code: PlanCode,
  ): Promise<Map<string, boolean>> {
    const flags = await tx
      .select()
      .from(planFeatures)
      .where(eq(planFeatures.planCode, code))
      .orderBy(asc(planFeatures.featureKey));
    const overrides = await tx
      .select()
      .from(tenantFeatureOverrides)
      .where(eq(tenantFeatureOverrides.tenantId, tenantId));
    const byKey = new Map(flags.map((f) => [f.featureKey, f.enabled]));
    for (const o of overrides) byKey.set(o.featureKey, o.enabled);
    return byKey;
  }

  /** Tenant có dùng được tính năng `key` không (gói hiệu lực tại lúc gọi: Pro hết hạn là về cờ của Free ngay). */
  async hasFeature(tx: Tx, tenantId: string, key: string): Promise<boolean> {
    const { code } = await this.load(tx, tenantId, new Date());
    return (await this.featureMap(tx, tenantId, code)).get(key) ?? false;
  }

  async usage(tx: Tx, tenantId: string, now = new Date()): Promise<PlanUsage> {
    const { sub, status, code, limits } = await this.load(tx, tenantId, now);
    const counts = await this.activeCounts(tx, tenantId);

    const byKey = await this.featureMap(tx, tenantId, code);

    const [pending] = await tx
      .select()
      .from(bankTransferOrders)
      .where(
        and(
          eq(bankTransferOrders.tenantId, tenantId),
          eq(bankTransferOrders.status, 'pending'),
        ),
      );
    const end = status === 'free' ? null : sub.currentPeriodEnd;
    return {
      plan: {
        code,
        status,
        source:
          (sub.source as 'app_store' | 'play_store' | 'bank_transfer' | null) ??
          null,
        currentPeriodEnd: end?.toISOString() ?? null,
        daysLeft: end ? daysLeft(end, now) : null,
        trialUsedAt: sub.trialUsedAt?.toISOString() ?? null,
        trialAvailable: sub.trialUsedAt === null && code === 'free',
      },
      limits: {
        maxActiveClasses: limits.max_active_classes,
        maxActiveStudents: limits.max_active_students,
      },
      usage: { activeClasses: counts.classes, activeStudents: counts.students },
      readOnly: {
        classCount: overLimit(counts.classes, limits.max_active_classes),
        studentCount: overLimit(counts.students, limits.max_active_students),
      },
      features: [...byKey]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, enabled]) => ({ key, enabled })),
      proPriceVnd: this.config.get('PRO_PRICE_VND') ?? null,
      pendingBankTransferOrder: pending ? toOrder(pending) : null,
    };
  }
}
