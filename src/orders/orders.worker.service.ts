import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { Service, ServiceDocument } from '../schemas/services.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';
import { REDIS_CLIENT } from '../redis/redis.module';
// 
import { PENDING_ORDERS_KEY } from './orders.scheduler';
import type { Redis } from 'ioredis';


/** Thời gian nghỉ khi Redis không có order nào */
const POLL_INTERVAL_MS = 3000;
/** Lock mỗi order tối đa 5 phút để tránh deadlock */
const ORDER_LOCK_TTL_SECONDS = 300;
/** Số lần thử lại khi buy() thất bại */
const MAX_RETRIES = 3;
/** Delay giữa các lần retry (ms) */
const RETRY_DELAY_MS = 2000;

@Injectable()
export class OrdersWorkerService implements OnModuleInit {
  private readonly logger = new Logger(OrdersWorkerService.name);
  private running = true;

  constructor(
    @InjectModel(Order.name)   private readonly orderModel:   Model<OrderDocument>,
    @InjectModel(Partner.name) private readonly partnerModel: Model<PartnerDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @Inject(REDIS_CLIENT)      private readonly redis:        Redis,
    private readonly providerFactory: ProxyProviderFactory,
  ) {}

  onModuleInit() {
    void this.startWorker();
  }

  private async startWorker(): Promise<void> {
    this.logger.log('Worker started — polling Redis for pending orders...');

    while (this.running) {

      try {
        await this.processOneBatch();
      } catch (err) {
        this.logger.error('Unexpected worker error', err?.message);
        await this.sleep(POLL_INTERVAL_MS);
      }
    }
  }

  private async processOneBatch(): Promise<void> {
    const raw = await this.redis.get(PENDING_ORDERS_KEY);

    if (!raw) {
      await this.sleep(POLL_INTERVAL_MS);
      return;
    }

    const ids: string[] = JSON.parse(raw);

    if (ids.length === 0) {
      await this.sleep(POLL_INTERVAL_MS);
      return;
    }

    this.logger.log(`Found ${ids.length} pending order IDs in Redis`);

    // Xử lý song song — mỗi order có lock riêng để tránh trùng giữa các worker
    await Promise.allSettled(ids.map(id => this.processOrder(id)));

    // Sleep sau khi xử lý xong — tránh spin loop khi Redis cache chưa được refresh
    await this.sleep(POLL_INTERVAL_MS);
  }

  private async processOrder(orderId: string): Promise<void> {
    // Claim lock per order — chỉ 1 worker xử lý 1 order
    let id_service_provider = '';
    const lockKey = `lock:order:${orderId}`;
    const claimed = await this.redis.set(lockKey, '1', 'EX', ORDER_LOCK_TTL_SECONDS, 'NX');
    if (!claimed) {
      this.logger.debug(`Order ${orderId}: lock đang bị giữ, bỏ qua`);
      return;
    }

    try {
      // Re-fetch từ DB để xác nhận vẫn còn PENDING (tránh race condition)
      const order = await this.orderModel.findOne({
        _id: new Types.ObjectId(orderId),
        status: OrderStatusEnum.PENDING,
      }).exec();

      if (!order) return;

      const [partner, service] = await Promise.all([
        order.partner_id ? this.partnerModel.findById(order.partner_id).exec() : null,
        order.service_id ? this.serviceModel.findById(order.service_id).exec() : null,
      ]);

      if (!partner || !partner.code) {
        this.logger.warn(`Order ${orderId}: không có partner, bỏ qua`);
        return;
      }

      const provider = this.providerFactory.getProvider(partner.code);

      const isp = (order.config?.isp as string ?? '').toLowerCase();
      switch (isp) {
        case 'vnpt':        id_service_provider = '528d39a9-f826-4c65-989c-4591d9f0dce3'; break;
        case 'viettel':     id_service_provider = 'f3ea6303-8b3e-4f8f-a0f7-43765929d3dd'; break;
        case 'fpt':         id_service_provider = 'f0be21c6-2deb-499c-9d5d-7bba3f765a26'; break;
      }

      // Retry buy() tối đa MAX_RETRIES lần
      const retryErrors: string[] = [];
      let result: any = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          result = await provider.buy({
            token_api:     partner.token_api,
            quantity:      order.quantity,
            duration_days: order.duration_days,
            proxy_type:    order.proxy_type,
            body_api:      service?.body_api,
            id_service:    id_service_provider,
            isp:           order.config?.isp      as string | undefined,
            protocol:      order.config?.protocol as string | undefined,
          });
          break; // Thành công — thoát loop
        } catch (err: any) {
          retryErrors.push(`[${attempt}/${MAX_RETRIES}] ${err?.message ?? 'Unknown error'}`);
          this.logger.warn(`Order ${orderId}: lần thử ${attempt}/${MAX_RETRIES} thất bại — ${err?.message}`);
          if (attempt < MAX_RETRIES) await this.sleep(RETRY_DELAY_MS);
        }
      }

      if (retryErrors.length === MAX_RETRIES || !result) {
        // Hết lần thử — disable partner + tất cả service liên quan
        const errorSummary = retryErrors.length
          ? retryErrors.join(' | ')
          : 'buy() returned null';
        this.logger.error(`Order ${orderId}: hết ${MAX_RETRIES} lần thử, disable partner "${partner.code}" — ${errorSummary}`);
        await Promise.all([
          this.partnerModel.findByIdAndUpdate(partner._id, { status: false }).exec(),
          this.serviceModel.updateMany({ partner: partner._id }, { status: false }).exec(),
        ]);
        throw new Error(errorSummary);
      }

      order!.provider_order_id = result.provider_order_id;
      order!.status  = OrderStatusEnum.PROCESSING;
      await order!.save();

      this.logger.log(`Order ${orderId} → PROCESSING (provider_order_id: ${result.provider_order_id})`);
    } catch (err) {
      this.logger.error(`Order ${orderId} thất bại: ${err?.message}`);
      await this.orderModel.findByIdAndUpdate(orderId, {
        status:        OrderStatusEnum.FAILED,
        error_message: err?.message ?? 'Worker error',
      }).exec();
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Gọi khi app shutdown để thoát vòng lặp sạch */
  stopWorker() {
    this.running = false;
    this.logger.log('Worker stopped');
  }
}
