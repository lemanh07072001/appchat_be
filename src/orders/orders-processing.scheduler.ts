import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { Proxy, ProxyDocument } from '../schemas/proxies.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { ProxyProtocolEnum } from '../enum/proxy.enum';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';

/** Số order xử lý song song mỗi batch — tránh rate limit */
const BATCH_SIZE = 20;

@Injectable()
export class OrdersProcessingScheduler implements OnModuleInit {
  private readonly logger = new Logger(OrdersProcessingScheduler.name);
  private isRunning = false;

  constructor(
    @InjectModel(Order.name)   private readonly orderModel:   Model<OrderDocument>,
    @InjectModel(Partner.name) private readonly partnerModel: Model<PartnerDocument>,
    @InjectModel(Proxy.name)   private readonly proxyModel:   Model<ProxyDocument>,
    private readonly providerFactory: ProxyProviderFactory,
  ) {}

  onModuleInit() {
    void this.pollProcessingOrders();
  }

  /** Poll HomeProxy mỗi 60 giây để lấy proxy cho PROCESSING orders */
  @Cron('0 * * * * *')
  async pollProcessingOrders(): Promise<void> {
    if (this.isRunning) return; // Bỏ qua nếu cycle trước chưa xong
    this.isRunning = true;

    try {
      const orders = await this.orderModel
        .find({ status: OrderStatusEnum.PROCESSING, provider_order_id: { $ne: '' } })
        .select('_id provider_order_id partner_id config')
        .lean()
        .exec();

      if (orders.length === 0) return;

      this.logger.log(`Polling ${orders.length} PROCESSING orders...`);

      // Load tất cả partner 1 lần — tránh N+1 query
      const partnerIds = [...new Set(orders.map(o => o.partner_id?.toString()).filter(Boolean))];
      const partners = await this.partnerModel
        .find({ _id: { $in: partnerIds } })
        .select('code token_api')
        .lean()
        .exec();
      const partnerMap = new Map(partners.map(p => [p._id.toString(), p]));

      // Xử lý theo batch để không hammer API
      for (let i = 0; i < orders.length; i += BATCH_SIZE) {
        const batch = orders.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(batch.map(o => this.fetchAndActivate(o, partnerMap)));
      }
    } catch (err) {
      this.logger.error('pollProcessingOrders error', err?.message);
    } finally {
      this.isRunning = false;
    }
  }

  private async fetchAndActivate(order: any, partnerMap: Map<string, any>): Promise<void> {
    try {
      const partner = partnerMap.get(order.partner_id?.toString());

      if (!partner?.code || !partner?.token_api) return;

      const provider = this.providerFactory.getProvider(partner.code);

      if (!provider.fetchOrderProxies) return; // Provider không hỗ trợ async fetch

      const proxies = await provider.fetchOrderProxies(
        partner.token_api,
        order.provider_order_id,
      );

      if (!proxies || proxies.length === 0) return; // Chưa có proxy — chờ cycle sau

      // Insert vào proxy collection — bỏ qua nếu đã tồn tại (idempotent)
      const proxyDocs = proxies.map((p: any) => ({
        order_id:          new Types.ObjectId(order._id),
        proxy_type_id:     order.service_id ? new Types.ObjectId(order.service_id) : null,
        ip_address:        p.host,
        port:              p.port,
        protocol:          (p.protocol?.toLowerCase() ?? 'http') as ProxyProtocolEnum,
        auth_username:     p.username,
        auth_password:     p.password,
        provider_proxy_id: p.provider_proxy_id ?? null,
        domain:            p.domain            ?? '',
        prev_ip:           p.prev_ip           ?? '',
        location:          p.location          ?? '',
        isp:               p.isp               ?? '',
        provider:          partner.code,
        country_code:      p.country_code      ?? 'VN',
        is_active:         true,
        is_available:      false,
      }));

      await this.proxyModel.insertMany(proxyDocs, { ordered: false });

      // Update order → ACTIVE
      await this.orderModel.findByIdAndUpdate(order._id, {
        status: OrderStatusEnum.ACTIVE,
      }).exec();

      this.logger.log(`Order ${order._id} → ACTIVE, inserted ${proxies.length} proxies`);
    } catch (err) {
      this.logger.error(`fetchAndActivate ${order._id}: ${err?.message}`);
    }
  }
}
