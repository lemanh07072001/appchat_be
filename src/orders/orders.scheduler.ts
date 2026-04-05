import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { Redis } from 'ioredis';

export const PENDING_ORDERS_KEY     = 'orders:pending';
export const PROCESSING_ORDERS_KEY  = 'orders:processing';
const LOCK_KEY         = 'lock:cache_pending_orders';
const LOCK_TTL_SECONDS = 120;    // tối đa 120s để chạy xong, tránh deadlock

@Injectable()
export class OrdersScheduler implements OnModuleInit {
  private readonly logger = new Logger(OrdersScheduler.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    void this.rePushPendingOrders();
  }

  /** Backup: chạy mỗi 30 phút — re-push PENDING orders bị miss (VD: Redis restart) */
  @Cron('*/30 * * * *')
  async rePushPendingOrders(): Promise<void> {
    const acquired = await this.redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!acquired) {
      this.logger.debug('Skipped: another instance is already running');
      return;
    }

    try {
      const orders = await this.orderModel
        .find({ status: OrderStatusEnum.PENDING })
        .select('_id')
        .lean()
        .exec();

      if (orders.length === 0) {
        this.logger.debug('No pending orders to re-push');
        return;
      }

      // Lấy danh sách order đang có trong Redis list để tránh push trùng
      const existingIds = new Set(await this.redis.lrange(PENDING_ORDERS_KEY, 0, -1));

      let pushed = 0;
      for (const order of orders) {
        const orderId = order._id.toString();

        // Bỏ qua nếu đã có trong list hoặc đang bị lock (worker đang xử lý)
        if (existingIds.has(orderId)) continue;
        const isLocked = await this.redis.exists(`lock:order:${orderId}`);
        if (isLocked) continue;

        await this.redis.lpush(PENDING_ORDERS_KEY, orderId);
        pushed++;
      }

      if (pushed > 0) {
        this.logger.log(`Re-pushed ${pushed} pending order(s) → Redis list "${PENDING_ORDERS_KEY}"`);
      }
    } catch (err) {
      this.logger.error('Failed to re-push pending orders', err?.stack ?? err?.message);
    } finally {
      await this.redis.del(LOCK_KEY);
    }
  }
}
