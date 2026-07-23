import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  RenewalSelection,
  RenewalSelectionDocument,
} from './schemas/renewal-selection.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { OrdersService } from '../orders/orders.service';
import { NotificationGateway } from '../webhook/notification.gateway';

const SCAN_LOCK_KEY = 'lock:auto_renew_scan';
const SCAN_LOCK_TTL = 600; // 10 phút — đủ cho một lượt quét
const BATCH_SIZE = 50;
const VN_OFFSET = 7 * 3600000;

/** Actor ghi vào order log / wallet tx để phân biệt với gia hạn tay */
const AUTO_ACTOR = 'auto-renew';

/** Nhận diện lỗi thiếu số dư ở CẢ HAI đường: throw top-level và result.error */
function isInsufficientBalance(message?: string): boolean {
  return !!message && message.includes('Số dư không đủ');
}

@Injectable()
export class RenewScheduler implements OnModuleInit {
  private readonly logger = new Logger(RenewScheduler.name);

  constructor(
    @InjectModel(RenewalSelection.name)
    private readonly selectionModel: Model<RenewalSelectionDocument>,
    @InjectModel(Proxy.name) private readonly proxyModel: Model<ProxyDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly ordersService: OrdersService,
    private readonly notification: NotificationGateway,
  ) {}

  /**
   * Backfill cờ is_renewed cho đơn đã gia hạn trước khi có cờ này
   * (chạy 1 lần lúc khởi động, idempotent — lần sau không còn gì để cập nhật).
   */
  async onModuleInit(): Promise<void> {
    try {
      const res = await this.orderModel.updateMany(
        { renew_count: { $gt: 0 }, is_renewed: { $ne: true } },
        { $set: { is_renewed: true } },
      ).exec();
      if (res.modifiedCount > 0) {
        this.logger.log(
          `[auto-renew] Backfill is_renewed cho ${res.modifiedCount} đơn đã gia hạn`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`[auto-renew] Backfill is_renewed lỗi: ${err?.message}`);
    }
  }

  /**
   * Báo kết quả — thông báo là phụ trợ, lỗi ở đây tuyệt đối không được
   * làm hỏng luồng gia hạn (trạng thái bền đã lưu ở last_run_*).
   */
  private notify(
    userId: string,
    data: Parameters<NotificationGateway['sendAutoRenewResult']>[1],
  ): void {
    this.notification
      .sendAutoRenewResult(userId, data)
      .catch((err) =>
        this.logger.warn(`[auto-renew] Gửi thông báo thất bại: ${err?.message}`),
      );
  }

  /** 8h sáng giờ VN mỗi ngày — quét các bộ đã bật lịch tự gia hạn */
  @Cron('0 8 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scanAndRenew(): Promise<void> {
    const acquired = await this.redis.set(
      SCAN_LOCK_KEY, '1', 'EX', SCAN_LOCK_TTL, 'NX',
    );
    if (!acquired) {
      this.logger.debug('[auto-renew] Skipped: instance khác đang chạy');
      return;
    }

    const t0 = Date.now();
    let processed = 0;
    let renewed = 0;
    let disabled = 0;

    try {
      const selections = await this.selectionModel
        .find({ auto_renew_enabled: true })
        .limit(BATCH_SIZE)
        .exec();

      if (selections.length === 0) {
        this.logger.debug('[auto-renew] Không có bộ nào bật lịch');
        return;
      }

      for (const selection of selections) {
        try {
          const outcome = await this.runSelection(selection);
          if (outcome === 'renewed') renewed++;
          if (outcome === 'disabled') disabled++;
          if (outcome !== 'skipped') processed++;
        } catch (err: any) {
          this.logger.error(
            `[auto-renew] Bộ ${selection._id.toString()} lỗi: ${err?.message}`,
            err?.stack,
          );
        }
      }

      this.logger.log(
        `[auto-renew] Quét ${selections.length} bộ · xử lý ${processed} · ` +
        `gia hạn ${renewed} · tắt lịch ${disabled} · ${Date.now() - t0}ms`,
      );
    } catch (err: any) {
      this.logger.error(`[auto-renew] Quét thất bại: ${err?.message}`, err?.stack);
    } finally {
      await this.redis.del(SCAN_LOCK_KEY);
    }
  }

  /**
   * Xử lý một bộ: tìm proxy thuộc đơn sắp hết hạn → gia hạn → ghi trạng thái.
   * Chỉ gia hạn proxy của đơn TỚI HẠN, không gia hạn cả bộ (an toàn chi phí).
   */
  private async runSelection(
    selection: RenewalSelectionDocument,
  ): Promise<'renewed' | 'disabled' | 'failed' | 'skipped'> {
    const selectionId = selection._id.toString();
    const userId = selection.user_id.toString();
    const thresholdDays = selection.threshold_days ?? 3;
    const durationDays = selection.duration_days ?? 30;

    if (!selection.proxy_ids?.length) return 'skipped';

    // 1. Proxy nào thuộc đơn ACTIVE sắp hết hạn?
    const now = new Date();
    const threshold = new Date(now.getTime() + thresholdDays * 86400000);

    const proxies = await this.proxyModel
      .find({ _id: { $in: selection.proxy_ids } })
      .select('order_id provider_proxy_id')
      .lean()
      .exec();

    const orderIds = [
      ...new Set(
        proxies
          .filter((p) => p.order_id && p.provider_proxy_id)
          .map((p) => p.order_id!.toString()),
      ),
    ];
    if (orderIds.length === 0) return 'skipped';

    const dueOrders = await this.orderModel
      .find({
        _id: { $in: orderIds.map((id) => new Types.ObjectId(id)) },
        status: OrderStatusEnum.ACTIVE,
        end_date: { $ne: null, $lte: threshold },
      })
      .select('_id')
      .lean()
      .exec();

    if (dueOrders.length === 0) return 'skipped'; // chưa tới hạn — không ghi gì

    const dueOrderIds = new Set(dueOrders.map((o) => o._id.toString()));
    const dueProxyIds = proxies
      .filter(
        (p) =>
          p.order_id &&
          p.provider_proxy_id &&
          dueOrderIds.has(p.order_id.toString()),
      )
      .map((p) => p._id.toString());

    if (dueProxyIds.length === 0) return 'skipped';

    // 2. Khoá idempotency theo bộ + ngày (VN) — khoá chính hết TTL giữa chừng
    //    cũng KHÔNG thể trừ tiền hai lần trong cùng một ngày.
    const dayKey = new Date(now.getTime() + VN_OFFSET).toISOString().slice(0, 10);
    const runLock = `lock:auto_renew:${selectionId}:${dayKey}`;
    const claimed = await this.redis.set(runLock, '1', 'EX', 25 * 3600, 'NX');
    if (!claimed) {
      this.logger.debug(`[auto-renew] Bộ ${selectionId} đã chạy hôm nay — bỏ qua`);
      return 'skipped';
    }

    this.logger.log(
      `[auto-renew] Bộ "${selection.name}" (${selectionId}): gia hạn ` +
      `${dueProxyIds.length} proxy / ${dueOrders.length} đơn tới hạn, +${durationDays} ngày`,
    );

    // 3. Gia hạn — tái dùng nguyên luồng tiền đã kiểm chứng của gia hạn hàng loạt
    try {
      const result = await this.ordersService.bulkRenewByUser(
        userId,
        dueProxyIds,
        durationDays,
        { actor: AUTO_ACTOR },
      );

      // Thiếu tiền phát hiện ở tầng từng đơn (throw bị catch thành result failed)
      const brokeMidway = result.results.some((r) => isInsufficientBalance(r.error));
      if (brokeMidway) {
        await this.disableSchedule(
          selection,
          `Số dư không đủ để tự gia hạn toàn bộ. Đã gia hạn ${result.renewed_orders} đơn, ` +
          `phần còn lại thất bại. Lịch đã tạm tắt — nạp thêm tiền rồi bật lại.`,
          result.total_price,
          result.renewed_orders,
        );
        return 'disabled';
      }

      const failedCount = result.results.filter((r) => r.status === 'failed').length;
      const status: 'success' | 'partial' | 'failed' =
        result.renewed_orders === 0
          ? 'failed'
          : failedCount > 0 || result.results.some((r) => r.status === 'partial')
          ? 'partial'
          : 'success';

      const message =
        status === 'success'
          ? `Đã tự gia hạn ${result.renewed_orders} đơn (+${durationDays} ngày), ` +
            `trừ ${result.total_price.toLocaleString('vi-VN')}đ`
          : status === 'partial'
          ? `Tự gia hạn ${result.renewed_orders} đơn, ${failedCount} đơn có vấn đề — ` +
            `xem lịch sử đơn hàng`
          : `Tự gia hạn thất bại: ${result.results[0]?.error ?? 'lỗi nhà cung cấp'}` +
            (result.total_refunded > 0
              ? ` (đã hoàn ${result.total_refunded.toLocaleString('vi-VN')}đ)`
              : '');

      await this.saveRun(selection, status, message, result.bulk_ref);
      this.notify(userId, {
        selection_name: selection.name ?? 'Bộ tự động',
        status,
        message,
        renewed_orders: result.renewed_orders,
        total_price: result.total_price,
        balance_after: result.balance_after,
      });

      return result.renewed_orders > 0 ? 'renewed' : 'failed';
    } catch (err: any) {
      // Thiếu tiền phát hiện ở pre-check (throw top-level) → tắt lịch
      if (isInsufficientBalance(err?.message)) {
        await this.disableSchedule(
          selection,
          `${err.message}. Lịch tự gia hạn đã tạm tắt — nạp thêm tiền rồi bật lại.`,
          0,
          0,
        );
        return 'disabled';
      }

      const message = `Tự gia hạn thất bại: ${err?.message ?? 'Unknown'}`;
      this.logger.error(`[auto-renew] Bộ ${selectionId}: ${message}`);
      await this.saveRun(selection, 'failed', message, null);
      this.notify(userId, {
        selection_name: selection.name ?? 'Bộ tự động',
        status: 'failed',
        message,
        renewed_orders: 0,
        total_price: 0,
      });
      return 'failed';
    }
  }

  /** Tắt lịch (chỉ khi thiếu số dư) + ghi lý do để user thấy trên trang /renew */
  private async disableSchedule(
    selection: RenewalSelectionDocument,
    message: string,
    totalPrice: number,
    renewedOrders: number,
  ): Promise<void> {
    this.logger.warn(
      `[auto-renew] Tắt lịch bộ "${selection.name}" (${selection._id.toString()}): ${message}`,
    );
    await this.selectionModel.updateOne(
      { _id: selection._id },
      {
        $set: {
          auto_renew_enabled: false,
          last_run_at: new Date(),
          last_run_status: 'disabled',
          last_run_message: message,
        },
      },
    ).exec();

    this.notify(selection.user_id.toString(), {
      selection_name: selection.name ?? 'Bộ tự động',
      status: 'disabled',
      message,
      renewed_orders: renewedOrders,
      total_price: totalPrice,
    });
  }

  private async saveRun(
    selection: RenewalSelectionDocument,
    status: 'success' | 'partial' | 'failed',
    message: string,
    bulkRef: string | null,
  ): Promise<void> {
    await this.selectionModel.updateOne(
      { _id: selection._id },
      {
        $set: {
          last_run_at: new Date(),
          last_run_status: status,
          last_run_message: message,
          last_run_bulk_ref: bulkRef,
        },
      },
    ).exec();
  }
}
