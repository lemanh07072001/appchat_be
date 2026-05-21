import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { ProxyProtocolEnum } from '../enum/proxy.enum';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';
import { AffiliateService } from '../affiliate/affiliate.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { Redis } from 'ioredis';
import { OrderLogService } from './order-log.service';
import { OrderLogStep, OrderLogLevel } from '../schemas/order-log.schema';

/** Partner code có flow async polling (provider.buy() trả proxies: []) */
const ASYNC_POLLING_PARTNERS = ['homeproxy', 'twoproxy', 'proxyseller'];
/** Window phục hồi: chỉ thử lại order tạo trong khoảng này (phút) */
const RECOVERY_WINDOW_MINUTES = 30;
/** Số order xử lý mỗi tick scheduler */
const BATCH_SIZE              = 50;
/** Insert proxy theo batch */
const INSERT_BATCH_SIZE       = 500;

const LOCK_KEY         = 'lock:orders_recovery';
const LOCK_TTL_SECONDS = 120;

/**
 * Backup phục hồi cho các order PENDING_REFUND của provider async polling
 * (HomeProxy, 2Proxy, ProxySeller). Triệu chứng: provider cấp proxy chậm vượt
 * cửa sổ poll của OrdersProcessingWorkerService → order bị đẩy về PENDING_REFUND
 * mặc dù provider đã có proxy. Scheduler này quét lại fetchOrderProxies, nếu
 * provider đã trả proxy thì insert và đưa order về ACTIVE / PARTIAL.
 */
@Injectable()
export class OrdersRecoveryScheduler {
  private readonly logger = new Logger(OrdersRecoveryScheduler.name);

  constructor(
    @InjectModel(Order.name)   private readonly orderModel:   Model<OrderDocument>,
    @InjectModel(Partner.name) private readonly partnerModel: Model<PartnerDocument>,
    @InjectModel(Proxy.name)   private readonly proxyModel:   Model<ProxyDocument>,
    @Inject(REDIS_CLIENT)      private readonly redis:        Redis,
    private readonly providerFactory: ProxyProviderFactory,
    private readonly affiliateService: AffiliateService,
    private readonly orderLogService:  OrderLogService,
  ) {}

  @Cron('0 */2 * * * *')  // mỗi 2 phút — 15 cơ hội retry trong 30 phút
  async recoverLatePendingRefundOrders(): Promise<void> {
    const acquired = await this.redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!acquired) return;

    try {
      const cutoff = new Date(Date.now() - RECOVERY_WINDOW_MINUTES * 60_000);

      const orders = await this.orderModel
        .find({
          status:            OrderStatusEnum.PENDING_REFUND,
          provider_order_id: { $ne: '' },
          createdAt:         { $gte: cutoff },
        })
        .limit(BATCH_SIZE)
        .exec();

      if (orders.length === 0) return;

      this.logger.log(`Recovery scan: ${orders.length} order(s) PENDING_REFUND trong ${RECOVERY_WINDOW_MINUTES} phút gần đây`);

      for (const order of orders) {
        await this.tryRecover(order).catch((err) =>
          this.logger.error(`Recovery order ${order._id}: ${err?.message}`),
        );
      }
    } catch (err) {
      this.logger.error('recoverLatePendingRefundOrders error', err?.message);
    } finally {
      await this.redis.del(LOCK_KEY);
    }
  }

  private async tryRecover(order: OrderDocument): Promise<void> {
    const orderId = (order._id as Types.ObjectId).toString();

    if (!order.partner_id) return;
    const partner = await this.partnerModel
      .findById(order.partner_id)
      .select('code token_api')
      .exec();

    if (!partner?.code || !partner?.token_api) return;
    if (!ASYNC_POLLING_PARTNERS.includes(partner.code)) return;

    // Idempotent: nếu proxy đã có (admin import tay hoặc race), chỉ heal status
    const existing = await this.proxyModel.countDocuments({ order_id: order._id }).exec();
    if (existing > 0) {
      const newStatus = existing < order.quantity ? OrderStatusEnum.PARTIAL : OrderStatusEnum.ACTIVE;
      await this.orderModel.findByIdAndUpdate(order._id, {
        status:         newStatus,
        actual_quantity: existing < order.quantity ? existing : null,
        error_message:  '',
        admin_note:     `Auto-recovered: proxy đã tồn tại trong DB (${existing}/${order.quantity})`,
      }).exec();
      void this.orderLogService.info(orderId, OrderLogStep.RECOVERY_SUCCEEDED,
        `Heal status do proxy đã có sẵn (${existing}/${order.quantity})`,
        { existing, ordered: order.quantity, new_status: newStatus },
      );
      return;
    }

    const provider = this.providerFactory.getProvider(partner.code);
    if (!provider.fetchOrderProxies) return;

    void this.orderLogService.info(orderId, OrderLogStep.RECOVERY_ATTEMPTED,
      `Thử fetchOrderProxies cho order PENDING_REFUND`,
      { partner_code: partner.code, provider_order_id: order.provider_order_id },
    );

    let proxies: any[];
    try {
      proxies = await provider.fetchOrderProxies(
        partner.token_api,
        order.provider_order_id,
        { metadata: order.provider_metadata },
      );
    } catch (err: any) {
      this.logger.warn(`Recovery ${orderId}: fetchOrderProxies error — ${err?.message}`);
      void this.orderLogService.warn(orderId, OrderLogStep.RECOVERY_FAILED,
        `fetchOrderProxies lỗi: ${err?.message}`,
        { error: err?.message },
      );
      return;
    }

    if (!proxies || proxies.length === 0) {
      // Provider vẫn chưa cấp xong — chờ tick sau, không log spam
      return;
    }

    const isCdk = (order.config as any)?.is_cdk === true;
    const proxyDocs = proxies.map((p: any) => ({
      order_id:          order._id,
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
      cdk_key:           isCdk ? randomBytes(16).toString('hex') : undefined,
    }));

    let validationError: string | null = null;
    for (let i = 0; i < proxyDocs.length; i += INSERT_BATCH_SIZE) {
      try {
        await this.proxyModel.insertMany(
          proxyDocs.slice(i, i + INSERT_BATCH_SIZE),
          { ordered: false },
        );
      } catch (err: any) {
        if (err?.code === 11000) continue; // duplicate — bỏ qua
        validationError = err?.message ?? String(err);
        this.logger.error(`Recovery ${orderId}: insertMany error — ${validationError}`);
        break;
      }
    }

    // Xác nhận thực tế đã insert được bao nhiêu (bù trừ duplicate / validation drop)
    const inserted = await this.proxyModel.countDocuments({ order_id: order._id }).exec();
    if (inserted === 0) {
      void this.orderLogService.error(orderId, OrderLogStep.RECOVERY_FAILED,
        `Insert proxy thất bại (0 docs lưu được): ${validationError ?? 'unknown'}`,
        { received: proxies.length, error: validationError, sample: proxyDocs[0] },
      );
      return;
    }

    const ordered  = order.quantity;
    const newStatus = inserted < ordered ? OrderStatusEnum.PARTIAL : OrderStatusEnum.ACTIVE;
    const note     = `Auto-recovered after late provisioning: nhận ${inserted}/${ordered} proxy`;

    await this.orderModel.findByIdAndUpdate(order._id, {
      status:          newStatus,
      actual_quantity: inserted < ordered ? inserted : null,
      error_message:   '',
      admin_note:      note,
    }).exec();

    this.logger.log(`Recovery ${orderId} → ${OrderStatusEnum[newStatus]}: ${inserted}/${ordered}`);

    void this.orderLogService.bulkLog([
      {
        order_id: orderId,
        step:     OrderLogStep.RECOVERY_SUCCEEDED,
        level:    inserted < ordered ? OrderLogLevel.WARN : OrderLogLevel.INFO,
        message:  note,
        data:     { received: inserted, ordered, partner_code: partner.code, new_status: newStatus },
      },
    ]);

    if (newStatus === OrderStatusEnum.ACTIVE) {
      void this.affiliateService.handleOrderActive(order);
    }
  }
}
