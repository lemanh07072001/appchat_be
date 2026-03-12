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
import { REDIS_CLIENT, REDIS_BLOCKING_CLIENT } from '../redis/redis.module';
import { PENDING_ORDERS_KEY, PROCESSING_ORDERS_KEY } from './orders.scheduler';
import type { Redis } from 'ioredis';
import { OrderLogService } from './order-log.service';
import { OrderLogStep, OrderLogLevel } from '../schemas/order-log.schema';


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
/** Số order fail liên tiếp trước khi disable partner */
const PARTNER_FAIL_THRESHOLD = 5;
/** TTL của error counter (giây) — reset sau 30 phút không lỗi */
const PARTNER_FAIL_TTL_SECONDS = 1800;
/** Số order xử lý đồng thời tối đa */
const MAX_CONCURRENCY = 5;

@Injectable()
export class OrdersWorkerService implements OnModuleInit {
  private readonly logger = new Logger(OrdersWorkerService.name);
  private running = true;
  private activeCount = 0;

  constructor(
    @InjectModel(Order.name)   private readonly orderModel:   Model<OrderDocument>,
    @InjectModel(Partner.name) private readonly partnerModel: Model<PartnerDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Proxy.name)   private readonly proxyModel:   Model<ProxyDocument>,
    @Inject(REDIS_CLIENT)          private readonly redis:         Redis,
    @Inject(REDIS_BLOCKING_CLIENT) private readonly blockingRedis: Redis,
    private readonly providerFactory: ProxyProviderFactory,
    private readonly affiliateService: AffiliateService,
    private readonly orderLogService: OrderLogService,
  ) {}

  onModuleInit() {
    void this.startWorker();
  }

  private async startWorker(): Promise<void> {
    this.logger.log(`Worker started — concurrency: ${MAX_CONCURRENCY}, BRPOP waiting...`);

    while (this.running) {
      try {
        // Chờ nếu đang xử lý đủ slot
        if (this.activeCount >= MAX_CONCURRENCY) {
          await this.sleep(200);
          continue;
        }

        // BRPOP block chờ order mới — dùng blockingRedis riêng, tránh block lệnh thường
        const result = await this.blockingRedis.brpop(PENDING_ORDERS_KEY, BRPOP_TIMEOUT_SECONDS);

        if (!result) continue; // Timeout — không có order, loop lại

        const [, orderId] = result; // result = [key, value]
        this.logger.log(`Received order ${orderId} from Redis (active: ${this.activeCount + 1}/${MAX_CONCURRENCY})`);

        // Xử lý song song — không await, chạy nền
        this.activeCount++;
        void this.processOrder(orderId).finally(() => { this.activeCount--; });
      } catch (err) {
        this.logger.error('Unexpected worker error', err?.message);
        await this.sleep(2000);
      }
    }
  }

  private async processOrder(orderId: string): Promise<void> {
    const t0 = Date.now();

    // Claim lock per order — chỉ 1 worker xử lý 1 order
    const lockKey = `lock:order:${orderId}`;
    const claimed = await this.redis.set(lockKey, '1', 'EX', ORDER_LOCK_TTL_SECONDS, 'NX');
    if (!claimed) {
      this.logger.debug(`Order ${orderId}: lock đang bị giữ, bỏ qua`);
      void this.orderLogService.warn(orderId, OrderLogStep.WORKER_LOCK_SKIPPED, 'Lock đang bị giữ bởi worker khác, bỏ qua');
      return;
    }

    void this.orderLogService.info(orderId, OrderLogStep.WORKER_LOCK_ACQUIRED, 'Worker đã giữ lock và bắt đầu xử lý');

    try {
      // Re-fetch từ DB để xác nhận vẫn còn PENDING (tránh race condition)
      const order = await this.orderModel.findOne({
        _id: new Types.ObjectId(orderId),
        status: OrderStatusEnum.PENDING,
      }).exec();

      if (!order) {
        void this.orderLogService.warn(orderId, OrderLogStep.WORKER_ORDER_VERIFIED, 'Order không còn ở trạng thái PENDING, bỏ qua');
        return;
      }

      // Tính queue wait time: từ khi order được tạo → worker bắt đầu xử lý
      const orderCreatedAt = (order as any).createdAt as Date | undefined;
      const queueWaitMs = orderCreatedAt ? t0 - orderCreatedAt.getTime() : null;
      this.logger.log(`Order ${orderId}: [STEP 1] Queue wait = ${queueWaitMs ?? '?'}ms`);

      void this.orderLogService.info(orderId, OrderLogStep.WORKER_ORDER_VERIFIED, 'Order xác nhận PENDING, tiếp tục xử lý', {
        queue_wait_ms: queueWaitMs,
      });

      const [partner, service] = await Promise.all([
        order.partner_id ? this.partnerModel.findById(order.partner_id).exec() : null,
        order.service_id ? this.serviceModel.findById(order.service_id).exec() : null,
      ]);

      if (!partner || !partner.code) {
        throw new Error('Order không có partner hợp lệ');
      }

      const provider = this.providerFactory.getProvider(partner.code);

      let idService = '';
      const isp = (order.config?.isp as string) ?? '';

      if (partner.code === 'homeproxy') {
        const isRotating = order.order_type === 'rotating';

        if (isRotating) {
          // Proxy xoay — chọn theo duration_days
          switch (order.duration_days) {
            case 1:  idService = '7d57163a-9e09-4ee1-b52f-8c99dff60aa9'; break;
            case 7:  idService = '604b3b98-cb4c-4e48-aadb-0557dcffa48d'; break;
            case 30: idService = 'f792c198-380a-4851-89f7-408b432e46fa'; break;
            default: throw new Error(`Service không hỗ trợ gói ${order.duration_days} ngày`);
          }
        } else {
          // Proxy tĩnh — chọn theo ISP
          switch (isp.toLowerCase()) {
            case 'vnpt':    idService = '528d39a9-f826-4c65-989c-4591d9f0dce3'; break;
            case 'viettel': idService = 'f3ea6303-8b3e-4f8f-a0f7-43765929d3dd'; break;
            case 'fpt':     idService = 'f0be21c6-2deb-499c-9d5d-7bba3f765a26'; break;
            default: throw new Error(`Service không hỗ trợ ISP "${isp}"`);
          }
        }
      } else if (partner.code === 'proxyvn') {
        // ProxyVN dùng tên loại proxy — capitalize chữ đầu (VD: viettel → Viettel)
        const raw = service?.id_service || isp;
        idService = raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : '';
      } else {
        idService = service?.id_service || '';
      }

      // Retry buy() tối đa MAX_RETRIES lần
      const retryErrors: string[] = [];
      let result: any = null;
      const tProviderStart = Date.now();

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const tAttempt = Date.now();
        try {
          this.logger.log(`Order ${orderId}: [STEP 2] Calling provider.buy() (attempt ${attempt}/${MAX_RETRIES})`);
          void this.orderLogService.info(
            orderId,
            OrderLogStep.WORKER_PROVIDER_CALL,
            `Gọi provider.buy() lần ${attempt}/${MAX_RETRIES}`,
            {
              attempt,
              partner_code: partner.code,
              id_service:   idService,
              quantity:     order.quantity,
              duration_days: order.duration_days,
              isp:          order.config?.isp,
              protocol:     order.config?.protocol,
            },
          );

          let bodyApi: any = {};
          try { bodyApi = JSON.parse(service?.body_api ?? '{}'); } catch {}

          result = await provider.buy({
            token_api:        partner.token_api,
            quantity:         order.quantity,
            duration_days:    order.duration_days,
            proxy_type:       order.proxy_type,
            body_api:         service?.body_api,
            id_service:       idService,
            isp:              order.config?.isp             as string | undefined,
            protocol:         order.config?.protocol        as string | undefined,
            rotate_interval:  order.config?.rotate_interval as number | undefined,
            is_cdk:           bodyApi?.isCdk === true,
          });

          const providerCallMs = Date.now() - tAttempt;
          this.logger.log(`Order ${orderId}: [STEP 2] provider.buy() OK in ${providerCallMs}ms (attempt ${attempt})`);
          void this.orderLogService.info(
            orderId,
            OrderLogStep.WORKER_PROVIDER_OK,
            `provider.buy() thành công lần ${attempt}`,
            {
              attempt,
              duration_ms:       providerCallMs,
              provider_order_id: result?.provider_order_id,
              proxies_returned:  result?.proxies?.length ?? 0,
            },
          );

          break; // Thành công — thoát loop
        } catch (err: any) {
          retryErrors.push(`[${attempt}/${MAX_RETRIES}] ${err?.message ?? 'Unknown error'}`);
          this.logger.warn(`Order ${orderId}: lần thử ${attempt}/${MAX_RETRIES} thất bại — ${err?.message}`);

          void this.orderLogService.warn(
            orderId,
            OrderLogStep.WORKER_PROVIDER_RETRY,
            `provider.buy() thất bại lần ${attempt}/${MAX_RETRIES}: ${err?.message}`,
            { attempt, error: err?.message, duration_ms: Date.now() - tAttempt },
          );

          if (attempt < MAX_RETRIES) await this.sleep(RETRY_DELAY_MS);
        }
      }

      if (retryErrors.length === MAX_RETRIES || !result) {
        const errorSummary = retryErrors.length
          ? retryErrors.join(' | ')
          : 'buy() returned null';

        // Tăng error counter theo partner — chỉ disable khi vượt ngưỡng liên tiếp
        const failKey = `partner:fail:${partner._id}`;
        const failCount = await this.redis.incr(failKey);
        await this.redis.expire(failKey, PARTNER_FAIL_TTL_SECONDS);

        void this.orderLogService.warn(
          orderId,
          OrderLogStep.WORKER_PARTNER_FAIL_COUNT,
          `Partner "${partner.code}" fail count: ${failCount}/${PARTNER_FAIL_THRESHOLD}`,
          { partner_id: partner._id?.toString(), partner_code: partner.code, fail_count: failCount, threshold: PARTNER_FAIL_THRESHOLD },
        );

        if (failCount >= PARTNER_FAIL_THRESHOLD) {
          this.logger.error(`Partner "${partner.code}": ${failCount} order fail liên tiếp → disable partner + services`);
          await Promise.all([
            this.partnerModel.findByIdAndUpdate(partner._id, { status: false }).exec(),
            this.serviceModel.updateMany({ partner: partner._id }, { status: false }).exec(),
            this.redis.del(failKey),
          ]);

          void this.orderLogService.error(
            orderId,
            OrderLogStep.WORKER_PARTNER_DISABLED,
            `Partner "${partner.code}" bị disable do vượt ngưỡng lỗi ${PARTNER_FAIL_THRESHOLD}`,
            { partner_id: partner._id?.toString(), partner_code: partner.code, fail_count: failCount },
          );
        } else {
          this.logger.warn(`Order ${orderId}: fail (${failCount}/${PARTNER_FAIL_THRESHOLD}) — ${errorSummary}`);
        }

        void this.orderLogService.error(
          orderId,
          OrderLogStep.WORKER_PROVIDER_FAIL,
          `provider.buy() thất bại tất cả ${MAX_RETRIES} lần: ${errorSummary}`,
          { retries: MAX_RETRIES, errors: retryErrors },
        );

        throw new Error(errorSummary);
      }

      // Order thành công → reset error counter của partner
      const failKey = `partner:fail:${partner._id}`;
      await this.redis.del(failKey);

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
          const shortage = ordered - received;
          order!.actual_quantity = received;
          order!.status = OrderStatusEnum.PARTIAL;
          order!.admin_note = `Nhận ${received}/${ordered} proxy từ provider, thiếu ${shortage}`;
          await order!.save();
          this.logger.warn(`Order ${orderId} → PARTIAL: nhận ${received}/${ordered}, thiếu ${shortage}`);
          void this.orderLogService.bulkLog([
            { order_id: orderId, step: OrderLogStep.WORKER_PROXIES_INSERTED, message: `Insert ${received} proxies`, data: { received, ordered } },
            { order_id: orderId, step: OrderLogStep.WORKER_STATUS_PARTIAL, level: OrderLogLevel.WARN, message: `Order → PARTIAL: nhận ${received}/${ordered}`, data: { received, ordered, shortage } },
          ]);
        } else {
          order!.status = OrderStatusEnum.ACTIVE;
          await order!.save();
          this.logger.log(`Order ${orderId} → ACTIVE, inserted ${received} proxies`);
          void this.orderLogService.bulkLog([
            { order_id: orderId, step: OrderLogStep.WORKER_PROXIES_INSERTED, message: `Insert ${received} proxies`, data: { received, ordered } },
            { order_id: orderId, step: OrderLogStep.WORKER_STATUS_ACTIVE, message: `Order → ACTIVE`, data: { received, duration_ms: Date.now() - t0 } },
          ]);
          void this.affiliateService.handleOrderActive(order!);
        }
      } else {
        // Provider trả proxy async (HomeProxy) → push vào processing queue
        order!.status = OrderStatusEnum.PROCESSING;
        const tSave = Date.now();
        await order!.save();
        this.logger.log(`Order ${orderId}: [STEP 3a] order.save() took ${Date.now() - tSave}ms`);
        const tPush = Date.now();
        await this.redis.lpush(PROCESSING_ORDERS_KEY, orderId);
        this.logger.log(`Order ${orderId}: [STEP 3b] redis.lpush took ${Date.now() - tPush}ms`);
        this.logger.log(`Order ${orderId}: [STEP 3] → PROCESSING, pushed to processing queue (provider API took ${Date.now() - tProviderStart}ms, total worker ${Date.now() - t0}ms)`);
        void this.orderLogService.info(
          orderId,
          OrderLogStep.WORKER_STATUS_PROCESSING,
          `Order → PROCESSING: đã push vào processing queue`,
          { provider_order_id: result.provider_order_id, partner_code: partner.code },
        );
      }
    } catch (err) {
      this.logger.error(`Order ${orderId} thất bại: ${err?.message}`);
      await this.orderModel.findByIdAndUpdate(orderId, {
        status:        OrderStatusEnum.PENDING_REFUND,
        error_message: err?.message ?? 'Worker error',
      }).exec();

      void this.orderLogService.error(
        orderId,
        OrderLogStep.WORKER_STATUS_PENDING_REFUND,
        `Order → PENDING_REFUND do lỗi: ${err?.message}`,
        { error: err?.message, duration_ms: Date.now() - t0 },
      );
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
