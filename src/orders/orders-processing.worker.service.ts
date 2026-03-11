import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { ProxyProtocolEnum } from '../enum/proxy.enum';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';
import { AffiliateService } from '../affiliate/affiliate.service';
import { REDIS_CLIENT, REDIS_BLOCKING_CLIENT } from '../redis/redis.module';
import { PROCESSING_ORDERS_KEY } from './orders.scheduler';
import type { Redis } from 'ioredis';
import { OrderLogService } from './order-log.service';
import { OrderLogStep } from '../schemas/order-log.schema';

/** Timeout BRPOP — block tối đa 5s chờ order mới */
const BRPOP_TIMEOUT_SECONDS  = 5;
/** Delay giữa các lần poll khi chưa có proxy (ms) */
const POLL_INTERVAL_MS       = 1_000;
/** Số lần poll tối đa trước khi bỏ cuộc */
const MAX_POLL_ATTEMPTS      = 5;    // 5 × 3s = 15s tối đa
/** Số proxy insert mỗi batch */
const INSERT_BATCH_SIZE      = 500;
/** Số order xử lý đồng thời tối đa */
const MAX_CONCURRENCY        = 5;

@Injectable()
export class OrdersProcessingWorkerService implements OnModuleInit {
  private readonly logger = new Logger(OrdersProcessingWorkerService.name);
  private running     = true;
  private activeCount = 0;

  constructor(
    @InjectModel(Order.name)   private readonly orderModel:   Model<OrderDocument>,
    @InjectModel(Partner.name) private readonly partnerModel: Model<PartnerDocument>,
    @InjectModel(Proxy.name)   private readonly proxyModel:   Model<ProxyDocument>,
    @Inject(REDIS_CLIENT)          private readonly redis:         Redis,
    @Inject(REDIS_BLOCKING_CLIENT) private readonly blockingRedis: Redis,
    private readonly providerFactory: ProxyProviderFactory,
    private readonly affiliateService: AffiliateService,
    private readonly orderLogService:  OrderLogService,
  ) {}

  onModuleInit() {
    void this.startWorker();
  }

  private async startWorker(): Promise<void> {
    this.logger.log(`ProcessingWorker started — concurrency: ${MAX_CONCURRENCY}`);

    while (this.running) {
      try {
        if (this.activeCount >= MAX_CONCURRENCY) {
          await this.sleep(200);
          continue;
        }

        const result = await this.blockingRedis.brpop(PROCESSING_ORDERS_KEY, BRPOP_TIMEOUT_SECONDS);
        if (!result) continue;

        const [, orderId] = result;
        this.logger.log(`ProcessingWorker received order ${orderId} (active: ${this.activeCount + 1}/${MAX_CONCURRENCY})`);

        this.activeCount++;
        void this.pollUntilActive(orderId).finally(() => { this.activeCount--; });
      } catch (err) {
        this.logger.error('ProcessingWorker unexpected error', err?.message);
        await this.sleep(2000);
      }
    }
  }

  private async pollUntilActive(orderId: string): Promise<void> {
    const t0 = Date.now();
    this.logger.log(`Order ${orderId}: [STEP 4] ProcessingWorker started polling`);

    const order = await this.orderModel
      .findById(orderId)
      .select('_id provider_order_id partner_id service_id config user_id total_price quantity status')
      .exec();

    if (!order || order.status !== OrderStatusEnum.PROCESSING) {
      this.logger.debug(`Order ${orderId}: không còn PROCESSING, bỏ qua`);
      return;
    }

    const partner = order.partner_id
      ? await this.partnerModel.findById(order.partner_id).select('code token_api').exec()
      : null;

    if (!partner?.code || !partner?.token_api) {
      this.logger.warn(`Order ${orderId}: không có partner hợp lệ`);
      return;
    }

    const provider = this.providerFactory.getProvider(partner.code);
    if (!provider.fetchOrderProxies) {
      this.logger.warn(`Order ${orderId}: provider "${partner.code}" không hỗ trợ fetchOrderProxies`);
      return;
    }

    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      await this.sleep(POLL_INTERVAL_MS);

      try {
        const tPoll = Date.now();
        this.logger.log(`Order ${orderId}: [STEP 4] Poll attempt ${attempt}/${MAX_POLL_ATTEMPTS} (elapsed: ${tPoll - t0}ms)`);
        void this.orderLogService.info(
          orderId,
          OrderLogStep.POLLING_STARTED,
          `Poll lần ${attempt}/${MAX_POLL_ATTEMPTS} cho order PROCESSING`,
          { provider_order_id: order.provider_order_id, partner_code: partner.code, attempt },
        );

        const proxies = await provider.fetchOrderProxies(
          partner.token_api,
          order.provider_order_id,
        );
        this.logger.log(`Order ${orderId}: [STEP 4] fetchOrderProxies returned ${proxies?.length ?? 0} proxies (${Date.now() - tPoll}ms)`);

        if (!proxies || proxies.length === 0) {
          void this.orderLogService.info(
            orderId,
            OrderLogStep.POLLING_NO_PROXIES,
            `Lần ${attempt}: provider chưa trả proxy`,
            { attempt, elapsed_ms: Date.now() - t0 },
          );
          continue;
        }

        // Idempotent: skip nếu proxy đã insert
        const existing = await this.proxyModel.countDocuments({ order_id: order._id }).exec();
        if (existing > 0) {
          await this.orderModel.findByIdAndUpdate(order._id, { status: OrderStatusEnum.ACTIVE }).exec();
          void this.orderLogService.info(orderId, OrderLogStep.POLLING_PROXIES_OK, `Proxy đã tồn tại (${existing}), đảm bảo ACTIVE`);
          return;
        }

        // Batch insert
        const orderObjectId = new Types.ObjectId(order._id as any);
        const proxyDocs = proxies.map((p: any) => ({
          order_id:          orderObjectId,
          proxy_type_id:     order.service_id ?? null,
          ip_address:        p.host,
          port:              Number(p.port),
          protocol:          (p.protocol?.toLowerCase() ?? 'http') as ProxyProtocolEnum,
          auth_username:     p.username,
          auth_password:     p.password,
          provider_proxy_id: p.provider_proxy_id ?? undefined,
          domain:            p.domain   ?? '',
          prev_ip:           p.prev_ip  ?? '',
          location:          p.location ?? '',
          isp:               p.isp      ?? '',
          provider:          partner.code,
          country_code:      p.country_code ?? 'VN',
          is_active:         true,
          is_available:      false,
        }));

        for (let i = 0; i < proxyDocs.length; i += INSERT_BATCH_SIZE) {
          await this.proxyModel.insertMany(
            proxyDocs.slice(i, i + INSERT_BATCH_SIZE),
            { ordered: false },
          );
        }

        const received = proxies.length;
        const ordered  = order.quantity;

        if (received < ordered) {
          order.status = OrderStatusEnum.PARTIAL;
          (order as any).actual_quantity = received;
          (order as any).admin_note = `Nhận ${received}/${ordered} proxy từ provider`;
          await order.save();

          void this.orderLogService.warn(orderId, OrderLogStep.WORKER_STATUS_PARTIAL,
            `Order → PARTIAL: nhận ${received}/${ordered}`,
            { received, ordered, duration_ms: Date.now() - t0 },
          );
        } else {
          await this.orderModel.findByIdAndUpdate(order._id, { status: OrderStatusEnum.ACTIVE }).exec();
          this.logger.log(`Order ${orderId} → ACTIVE, inserted ${received} proxies (${Date.now() - t0}ms)`);

          void this.orderLogService.info(orderId, OrderLogStep.WORKER_STATUS_ACTIVE,
            `Order → ACTIVE: ${received} proxies sẵn sàng`,
            { received, duration_ms: Date.now() - t0 },
          );

          void this.affiliateService.handleOrderActive(order);
        }

        return; // Xong
      } catch (err) {
        this.logger.error(`Order ${orderId} poll lần ${attempt} lỗi: ${err?.message}`);
        void this.orderLogService.error(orderId, OrderLogStep.POLLING_FAILED,
          `Poll lần ${attempt} thất bại: ${err?.message}`,
          { attempt, error: err?.message },
        );
      }
    }

    // Hết MAX_POLL_ATTEMPTS → chuyển PENDING_REFUND
    const elapsed = Date.now() - t0;
    this.logger.warn(`Order ${orderId}: hết ${MAX_POLL_ATTEMPTS} lần poll (${elapsed}ms) → PENDING_REFUND`);

    await this.orderModel.findByIdAndUpdate(orderId, {
      status:        OrderStatusEnum.PENDING_REFUND,
      error_message: `Không nhận được proxy sau ${MAX_POLL_ATTEMPTS} lần poll (${elapsed}ms)`,
      admin_note:    `Auto PENDING_REFUND: ProcessingWorker poll ${MAX_POLL_ATTEMPTS} lần không có proxy từ provider`,
    }).exec();

    void this.orderLogService.error(orderId, OrderLogStep.POLLING_FAILED,
      `Hết ${MAX_POLL_ATTEMPTS} lần poll → PENDING_REFUND`,
      { attempts: MAX_POLL_ATTEMPTS, elapsed_ms: elapsed },
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  stopWorker() {
    this.running = false;
  }
}
