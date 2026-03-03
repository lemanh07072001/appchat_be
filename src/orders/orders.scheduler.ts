import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { Redis } from 'ioredis';

export const PENDING_ORDERS_KEY = 'orders:pending';
const CACHE_TTL_SECONDS = 360;   // 6 phút
const LOCK_KEY          = 'lock:cache_pending_orders';
const LOCK_TTL_SECONDS  = 60;    // tối đa 60s để chạy xong, tránh deadlock

@Injectable()
export class OrdersScheduler implements OnModuleInit {
  private readonly logger = new Logger(OrdersScheduler.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    void this.cachePendingOrders();
  }

  /** Chạy mỗi 5 phút */
  @Cron('*/5 * * * *')
  async cachePendingOrders(): Promise<void> {
    // Acquire lock: SET NX EX — chỉ 1 instance giành được lock
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

      const ids = orders.map(o => o._id.toString());

      await this.redis.set(
        PENDING_ORDERS_KEY,
        JSON.stringify(ids),
        'EX',
        CACHE_TTL_SECONDS,
      );

      this.logger.log(`Cached ${ids.length} pending order IDs → Redis key "${PENDING_ORDERS_KEY}"`);
    } catch (err) {
      this.logger.error('Failed to cache pending orders', err?.stack ?? err?.message);
    } finally {
      // Luôn giải phóng lock dù thành công hay lỗi
      await this.redis.del(LOCK_KEY);
    }
  }
}
