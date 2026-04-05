import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PROCESSING_ORDERS_KEY } from './orders.scheduler';
import type { Redis } from 'ioredis';

const LOCK_KEY         = 'lock:cache_processing_orders';
const LOCK_TTL_SECONDS = 120;

/**
 * Backup scheduler — chạy mỗi 5 phút re-push PROCESSING orders bị miss
 * (VD: server restart, Redis flush) vào processing queue.
 * Logic xử lý chính nằm ở OrdersProcessingWorkerService.
 */
@Injectable()
export class OrdersProcessingScheduler implements OnModuleInit {
  private readonly logger = new Logger(OrdersProcessingScheduler.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @Inject(REDIS_CLIENT)    private readonly redis: Redis,
  ) {}

  onModuleInit() {
    void this.rePushProcessingOrders();
  }

  @Cron('0 */5 * * * *')  // mỗi 5 phút
  async rePushProcessingOrders(): Promise<void> {
    const acquired = await this.redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!acquired) return;

    try {
      const orders = await this.orderModel
        .find({ status: OrderStatusEnum.PROCESSING, provider_order_id: { $ne: '' }, end_date: { $gt: new Date() } })
        .select('_id')
        .lean()
        .exec();

      if (orders.length === 0) return;

      const existingIds = new Set(await this.redis.lrange(PROCESSING_ORDERS_KEY, 0, -1));

      let pushed = 0;
      for (const order of orders) {
        const orderId = order._id.toString();
        if (existingIds.has(orderId)) continue;
        await this.redis.lpush(PROCESSING_ORDERS_KEY, orderId);
        pushed++;
      }

      if (pushed > 0) {
        this.logger.log(`Re-pushed ${pushed} PROCESSING order(s) → "${PROCESSING_ORDERS_KEY}"`);
      }
    } catch (err) {
      this.logger.error('rePushProcessingOrders error', err?.message);
    } finally {
      await this.redis.del(LOCK_KEY);
    }
  }
}
