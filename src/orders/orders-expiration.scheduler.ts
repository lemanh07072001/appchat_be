import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { OrderStatusEnum, OrderItemStatusEnum } from '../enum/order.enum';

/** Số order xử lý mỗi batch */
const BATCH_SIZE = 100;

@Injectable()
export class OrdersExpirationScheduler {
  private readonly logger = new Logger(OrdersExpirationScheduler.name);
  private isRunning = false;

  constructor(
    @InjectModel(Order.name)  private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Proxy.name)  private readonly proxyModel: Model<ProxyDocument>,
  ) {}

  /** Chạy mỗi 5 phút — check order ACTIVE đã hết hạn chưa */
  @Cron('*/5 * * * *')
  async checkExpiredOrders(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const now = new Date();

      // Tìm orders ACTIVE có end_date <= now
      const expiredOrders = await this.orderModel
        .find({
          status: OrderStatusEnum.ACTIVE,
          end_date: { $ne: null, $lte: now },
        })
        .select('_id order_code')
        .lean()
        .exec();

      if (expiredOrders.length === 0) {
        this.logger.debug('No expired orders found');
        return;
      }

      this.logger.log(`Found ${expiredOrders.length} expired order(s), processing...`);

      // Xử lý theo batch
      for (let i = 0; i < expiredOrders.length; i += BATCH_SIZE) {
        const batch = expiredOrders.slice(i, i + BATCH_SIZE);
        const orderIds = batch.map(o => o._id);

        // Cập nhật status order → EXPIRED
        await this.orderModel.updateMany(
          { _id: { $in: orderIds } },
          { status: OrderStatusEnum.EXPIRED },
        ).exec();

        // Tắt proxy liên quan
        await this.proxyModel.updateMany(
          { order_id: { $in: orderIds } },
          { is_active: false, is_available: false },
        ).exec();

        const codes = batch.map(o => o.order_code).join(', ');
        this.logger.log(`Expired batch: ${codes}`);
      }

      this.logger.log(`Total ${expiredOrders.length} order(s) marked as EXPIRED`);
    } catch (err) {
      this.logger.error('checkExpiredOrders error', err?.message);
    } finally {
      this.isRunning = false;
    }
  }
}
