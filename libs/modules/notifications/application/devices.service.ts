import { Injectable, Logger } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@teachhub/core';
import { devices, TxService, type Tx } from '@teachhub/db';
import { JobRuns, maskToken } from '@teachhub/infra';

export const JOB_PURGE_STALE_DEVICES = 'notify.purge-stale-devices';
/** Thiết bị không đăng ký lại (mỗi lần mở app / đổi token) quá chừng này ngày coi như đã bỏ. */
export const STALE_DEVICE_DAYS = 60;

/** Token FCM của thiết bị. Không bao giờ log token đầy đủ (chỉ dạng che). */
@Injectable()
export class DevicesService {
  private readonly log = new Logger(DevicesService.name);

  /**
   * Danh tính là `userId` của token đăng nhập. Hàm `app_private.register_device` xóa gắn kết cũ của token rồi upsert
   * theo token trong cùng giao dịch: đăng ký lặp → 1 dòng; token đang gắn user khác → chuyển sang user này.
   */
  async register(
    tx: Tx,
    token: string,
    platform: 'android' | 'ios',
  ): Promise<void> {
    await tx.execute(
      sql`select app_private.register_device(${uuidv7()}::uuid, ${token}, ${platform})`,
    );
    this.log.debug(`đăng ký thiết bị ${maskToken(token)} (${platform})`);
  }

  /** Chỉ xóa bản của chính user; token không có hoặc của người khác → không làm gì (RLS ẩn cả hai). */
  async unregister(tx: Tx, userId: string, token: string): Promise<void> {
    await tx
      .delete(devices)
      .where(and(eq(devices.userId, userId), eq(devices.token, token)));
    this.log.debug(`huỷ thiết bị ${maskToken(token)}`);
  }
}

/** Dọn thiết bị quá hạn (chạy bằng role worker). Trả số dòng đã xóa. */
@Injectable()
export class PurgeStaleDevicesJob {
  constructor(
    private readonly tx: TxService,
    private readonly runs: JobRuns,
  ) {}

  run(): Promise<number> {
    return this.runs.track(JOB_PURGE_STALE_DEVICES, async () => {
      const gone = await this.tx.run({ userId: null }, (t) =>
        t
          .delete(devices)
          .where(
            lt(
              devices.lastSeenAt,
              sql`now() - make_interval(days => ${STALE_DEVICE_DAYS})`,
            ),
          )
          .returning({ id: devices.id }),
      );
      return gone.length;
    });
  }
}
