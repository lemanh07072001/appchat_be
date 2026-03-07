import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { Service, ServiceDocument } from '../schemas/services.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { ProxyProtocolEnum } from '../enum/proxy.enum';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';
import { AffiliateService } from '../affiliate/affiliate.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PENDING_ORDERS_KEY } from './orders.scheduler';
import type { Redis } from 'ioredis';


/** Timeout BRPOP — block tối đa 5 giây chờ order mới */
const BRPOP_TIMEOUT_SECONDS = 5;
/** Lock mỗi order tối đa 5 phút để tránh deadlock */
const ORDER_LOCK_TTL_SECONDS = 300;
/** Số lần thử lại khi buy() thất bại */
const MAX_RETRIES = 3;
/** Delay giữa các lần retry (ms) */
const RETRY_DELAY_MS = 2000;
/** Số proxy insert mỗi batch để tránh quá tải MongoDB */
const INSERT_BATCH_SIZE = 500;

@Injectable()
export class OrdersWorkerService implements OnModuleInit {
  private readonly logger = new Logger(OrdersWorkerService.name);
  private running = true;

  constructor(
    @InjectModel(Order.name)   private readonly orderModel:   Model<OrderDocument>,
    @InjectModel(Partner.name) private readonly partnerModel: Model<PartnerDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Proxy.name)   private readonly proxyModel:   Model<ProxyDocument>,
    @Inject(REDIS_CLIENT)      private readonly redis:        Redis,
    private readonly providerFactory: ProxyProviderFactory,
    private readonly affiliateService: AffiliateService,
  ) {}

  onModuleInit() {
    void this.startWorker();
  }

  private async startWorker(): Promise<void> {
    this.logger.log('Worker started — BRPOP waiting for pending orders...');

    while (this.running) {
      try {
        // BRPOP block chờ order mới — trả về ngay khi có LPUSH
        const result = await this.redis.brpop(PENDING_ORDERS_KEY, BRPOP_TIMEOUT_SECONDS);

        if (!result) continue; // Timeout — không có order, loop lại

        const [, orderId] = result; // result = [key, value]
        this.logger.log(`Received order ${orderId} from Redis`);

        await this.processOrder(orderId);
      } catch (err) {
        this.logger.error('Unexpected worker error', err?.message);
        await this.sleep(2000);
      }
    }
  }

  private async processOrder(orderId: string): Promise<void> {
    // Claim lock per order — chỉ 1 worker xử lý 1 order
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

      let idService = '';
      const isp = (order.config?.isp as string) ?? '';

      if (partner.code === 'homeproxy') {
        // HomeProxy dùng UUID product ID
        switch (isp.toLowerCase()) {
          case 'vnpt':    idService = '528d39a9-f826-4c65-989c-4591d9f0dce3'; break;
          case 'viettel': idService = 'f3ea6303-8b3e-4f8f-a0f7-43765929d3dd'; break;
          case 'fpt':     idService = 'f0be21c6-2deb-499c-9d5d-7bba3f765a26'; break;
        }
      } else if (partner.code === 'proxyvn') {
        // ProxyVN dùng tên loại proxy trực tiếp
        idService = service?.id_service || isp;
      } else {
        idService = service?.id_service || '';
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
            id_service:    idService,
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

      // Nếu provider trả proxy ngay (ProxyVN) → lưu luôn
      if (result.proxies && result.proxies.length > 0) {
        const proxyDocs = result.proxies.map((p: any) => ({
          order_id:          order!._id,
          proxy_type_id:     order!.service_id ?? null,
          ip_address:        p.host,
          port:              Number(p.port),
          protocol:          (p.protocol?.toLowerCase() ?? 'http') as ProxyProtocolEnum,
          auth_username:     p.username,
          auth_password:     p.password,
          provider_proxy_id: p.provider_proxy_id ?? null,
          domain:            p.domain   ?? '',
          prev_ip:           p.prev_ip  ?? '',
          location:          p.location ?? '',
          isp:               p.isp      ?? '',
          provider:          partner.code,
          country_code:      p.country_code ?? 'VN',
          is_active:         true,
          is_available:      false,
        }));

        // Batch insert để tránh quá tải MongoDB khi SLL
        for (let i = 0; i < proxyDocs.length; i += INSERT_BATCH_SIZE) {
          await this.proxyModel.insertMany(
            proxyDocs.slice(i, i + INSERT_BATCH_SIZE),
            { ordered: false },
          );
        }

        const received = result.proxies.length;
        const ordered  = order!.quantity;

        if (received < ordered) {
          // Thiếu số lượng → PARTIAL, chờ admin refund
          const shortage = ordered - received;
          order!.actual_quantity = received;
          order!.status = OrderStatusEnum.PARTIAL;
          order!.admin_note = `Nhận ${received}/${ordered} proxy từ provider, thiếu ${shortage}`;
          await order!.save();
          this.logger.warn(`Order ${orderId} → PARTIAL: nhận ${received}/${ordered}, thiếu ${shortage}`);
        } else {
          order!.status = OrderStatusEnum.ACTIVE;
          await order!.save();
          this.logger.log(`Order ${orderId} → ACTIVE, inserted ${received} proxies`);
          void this.affiliateService.handleOrderActive(order!);
        }
      } else {
        // Provider trả proxy async (HomeProxy) → chờ scheduler poll
        order!.status = OrderStatusEnum.PROCESSING;
        await order!.save();
        this.logger.log(`Order ${orderId} → PROCESSING (provider_order_id: ${result.provider_order_id})`);
      }
    } catch (err) {
      this.logger.error(`Order ${orderId} thất bại: ${err?.message}`);
      await this.orderModel.findByIdAndUpdate(orderId, {
        status:        OrderStatusEnum.PENDING_REFUND,
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
