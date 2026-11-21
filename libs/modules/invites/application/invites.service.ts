import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AppException, type Env, secretKey, uuidv7 } from '@teachhub/core';
import { guardians, invites, students, type Tx } from '@teachhub/db';
import {
  generateShortCode,
  generateToken,
  hashShortCode,
  hashToken,
} from '../domain/invite-secrets.js';
import type {
  Invite,
  InviteCreated,
  InviteList,
} from '../http/invites.schemas.js';

type InviteRow = typeof invites.$inferSelect;
/** Cột đủ để dựng `Invite`: không có băm token/mã. */
type InviteView = Pick<
  InviteRow,
  | 'id'
  | 'studentId'
  | 'guardianId'
  | 'status'
  | 'createdAt'
  | 'expiresAt'
  | 'usedAt'
  | 'acceptedByName'
>;

const DAY_MS = 86_400_000;
const LINK_TTL_MS = 7 * DAY_MS;
const CODE_TTL_MS = 2 * DAY_MS;
/** Va chạm mã ngắn (2^40 không gian, chỉ so với lời mời còn hiệu lực) hiếm tới mức 5 lần liên tiếp là lỗi hệ thống. */
const MAX_CODE_ATTEMPTS = 5;

/** `expired` tính theo `expiresAt` lúc đọc; CSDL chỉ có pending/used/revoked. */
export function toInvite(r: InviteView, now: Date): Invite {
  return {
    id: r.id,
    studentId: r.studentId,
    guardianId: r.guardianId,
    status:
      r.status === 'pending' && r.expiresAt <= now
        ? 'expired'
        : (r.status as 'pending' | 'used' | 'revoked'),
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    acceptedBy:
      r.status === 'used' && r.usedAt
        ? {
            displayName: r.acceptedByName ?? '',
            acceptedAt: r.usedAt.toISOString(),
          }
        : null,
  };
}

/**
 * Lời mời phía giáo viên (US-1.6). Chỉ lưu băm; token và mã ngắn chỉ có trong giá trị trả về của `create`/`resend`.
 * Không log token, mã, SĐT. Mọi truy vấn lọc `tenant_id` tường minh (RLS là lớp thứ hai).
 */
@Injectable()
export class InvitesService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async create(
    tx: Tx,
    ctx: { tenantId: string; userId: string },
    studentId: string,
    guardianId: string,
  ): Promise<InviteCreated> {
    // Khóa dòng phụ huynh: hai lần tạo song song cho cùng người xếp hàng, lần sau vô hiệu lần trước.
    const [g] = await tx
      .select({ id: guardians.id, userId: guardians.userId })
      .from(guardians)
      .where(
        and(
          eq(guardians.tenantId, ctx.tenantId),
          eq(guardians.studentId, studentId),
          eq(guardians.id, guardianId),
          isNull(guardians.deletedAt),
        ),
      )
      .for('no key update');
    // Học viên/phụ huynh của tenant khác hay không khớp nhau đều cùng 404.
    if (!g) throw new AppException('NOT_FOUND');
    return this.issue(tx, ctx, studentId, g);
  }

  async resend(
    tx: Tx,
    ctx: { tenantId: string; userId: string },
    inviteId: string,
  ): Promise<InviteCreated> {
    const old = await this.find(tx, ctx.tenantId, inviteId);
    if (old.status === 'used') throw new AppException('CONFLICT_STALE');
    const [g] = await tx
      .select({ id: guardians.id, userId: guardians.userId })
      .from(guardians)
      .where(
        and(
          eq(guardians.tenantId, ctx.tenantId),
          eq(guardians.id, old.guardianId),
          isNull(guardians.deletedAt),
        ),
      )
      .for('no key update');
    if (!g) throw new AppException('NOT_FOUND');
    return this.issue(tx, ctx, old.studentId, g);
  }

  private async issue(
    tx: Tx,
    ctx: { tenantId: string; userId: string },
    studentId: string,
    g: { id: string; userId: string | null },
  ): Promise<InviteCreated> {
    if (g.userId) throw new AppException('CONFLICT_STALE'); // đã kích hoạt
    // Vô hiệu lời mời cũ và tạo mới trong cùng giao dịch: không có khoảng hở hai link cùng sống.
    await tx
      .update(invites)
      .set({ status: 'revoked', revokedAt: sql`now()` })
      .where(
        and(
          eq(invites.tenantId, ctx.tenantId),
          eq(invites.guardianId, g.id),
          eq(invites.status, 'pending'),
        ),
      );
    const codeKey = secretKey(
      this.config.get('INVITE_CODE_HMAC_KEY'),
      'INVITE_CODE_HMAC_KEY',
    );
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const token = generateToken();
      const shortCode = generateShortCode();
      const now = Date.now();
      const [row] = await tx
        .insert(invites)
        .values({
          id: uuidv7(),
          tenantId: ctx.tenantId,
          studentId,
          guardianId: g.id,
          tokenHash: hashToken(token),
          shortCodeHash: hashShortCode(shortCode, codeKey),
          shortCodeExpiresAt: new Date(now + CODE_TTL_MS),
          expiresAt: new Date(now + LINK_TTL_MS),
          createdBy: ctx.userId,
        })
        // Trùng mã ngắn của lời mời còn hiệu lực (unique từng phần) → sinh lại.
        .onConflictDoNothing()
        .returning();
      if (row) {
        return {
          ...toInvite(row, new Date()),
          token,
          shortCode,
          shortCodeExpiresAt: row.shortCodeExpiresAt.toISOString(),
          url: `${this.config.get('INVITE_BASE_URL')}#t=${token}`,
        };
      }
    }
    throw new AppException('INTERNAL_ERROR');
  }

  /** Lời mời mới nhất của từng phụ huynh chưa gỡ của học viên. */
  async list(tx: Tx, tenantId: string, studentId: string): Promise<InviteList> {
    const [s] = await tx
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.tenantId, tenantId), eq(students.id, studentId)));
    if (!s) throw new AppException('NOT_FOUND');
    const rows = await tx
      .selectDistinctOn([invites.guardianId], {
        id: invites.id,
        studentId: invites.studentId,
        guardianId: invites.guardianId,
        status: invites.status,
        createdAt: invites.createdAt,
        expiresAt: invites.expiresAt,
        usedAt: invites.usedAt,
        acceptedByName: invites.acceptedByName,
      })
      .from(invites)
      .innerJoin(guardians, eq(guardians.id, invites.guardianId))
      .where(
        and(
          eq(invites.tenantId, tenantId),
          eq(invites.studentId, studentId),
          isNull(guardians.deletedAt),
        ),
      )
      .orderBy(invites.guardianId, desc(invites.createdAt), desc(invites.id));
    const now = new Date();
    return {
      items: rows
        .map((r) => toInvite(r, now))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  }

  async revoke(tx: Tx, tenantId: string, inviteId: string): Promise<Invite> {
    const cur = await this.find(tx, tenantId, inviteId);
    if (cur.status === 'used') throw new AppException('CONFLICT_STALE');
    if (cur.status === 'revoked') return toInvite(cur, new Date());
    const [row] = await tx
      .update(invites)
      .set({ status: 'revoked', revokedAt: sql`now()` })
      // Điều kiện status giữ cho việc thu hồi không đè lên lời mời vừa được nhận song song.
      .where(
        and(
          eq(invites.tenantId, tenantId),
          eq(invites.id, inviteId),
          eq(invites.status, 'pending'),
        ),
      )
      .returning();
    if (!row) throw new AppException('CONFLICT_STALE');
    return toInvite(row, new Date());
  }

  private async find(
    tx: Tx,
    tenantId: string,
    inviteId: string,
  ): Promise<InviteRow> {
    const [row] = await tx
      .select()
      .from(invites)
      .where(and(eq(invites.tenantId, tenantId), eq(invites.id, inviteId)))
      .for('no key update');
    if (!row) throw new AppException('NOT_FOUND');
    return row;
  }
}
