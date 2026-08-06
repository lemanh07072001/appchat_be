import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { Partner, PartnerDocument } from '../schemas/partners.schema';
import { OrderStatusEnum } from '../enum/order.enum';
import { OrderLogService } from './order-log.service';
import { OrderLogStep } from '../schemas/order-log.schema';
import { ProxyProviderFactory } from '../proxy-providers/proxy-provider.factory';

const BATCH_SIZE = 50;

/**
 * Đồng bộ dung lượng đã dùng cho đơn bán theo GB, và kết thúc đơn khi cạn.
 *
 * Đơn bán theo thời hạn do `OrdersExpirationScheduler` lo (quét `end_date`).
 * Scheduler này lo chiều còn lại: đơn kết thúc vì tiêu hết hạn mức chứ không
 * phải vì hết ngày. Gói GB có kèm hạn ngày thì CẢ HAI scheduler cùng canh,
 * cái nào tới trước thì đơn dừng ở đó.
 *
 * ⚠ Nguồn số liệu là `IProxyProvider.fetchUsage()`. Provider nào chưa
 * implement thì đơn của provider đó bị bỏ qua và `bandwidth_used_gb` đứng yên —
 * xem log cảnh báo bên dưới.
 */
@Injectable()
export class OrdersBandwidthScheduler {
  private readonly logger = new Logger(OrdersBandwidthScheduler.name);
  private isRunning = false;

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Partner.name) private readonly partnerModel: Model<PartnerDocument>,
    private readonly orderLogService: OrderLogService,
    private readonly providerFactory: ProxyProviderFactory,
  ) {}

  /** Mỗi 10 phút — đủ nhanh để chặn vượt hạn mức, đủ chậm để không dội API nhà cung cấp. */
  @Cron('*/10 * * * *')
  async syncBandwidth(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const orders = await this.orderModel
        .find({
          pricing_mode: 'bandwidth',
          status: OrderStatusEnum.ACTIVE,
          provider_order_id: { $ne: '' },
        })
        .select('_id order_code partner_id provider_order_id provider_metadata bandwidth_gb bandwidth_used_gb')
        .limit(BATCH_SIZE)
        .lean()
        .exec();

      if (orders.length === 0) return;

      // Gom partner để không truy vấn lặp trong vòng lặp
      const partnerIds = [...new Set(orders.map((o) => String(o.partner_id)).filter(Boolean))];
      const partners = await this.partnerModel
        .find({ _id: { $in: partnerIds } })
        .select('_id code token_api')
        .lean()
        .exec();
      const partnerMap = new Map(partners.map((p) => [String(p._id), p]));

      for (const order of orders) {
        const orderId = String(order._id);
        const partner = partnerMap.get(String(order.partner_id));
        if (!partner) continue;

        let provider: ReturnType<ProxyProviderFactory['getProvider']>;
        try {
          provider = this.providerFactory.getProvider((partner as any).code);
        } catch {
          continue; // partner chưa có provider tương ứng
        }

        if (typeof provider.fetchUsage !== 'function') {
          this.logger.warn(
            `Provider "${(partner as any).code}" chưa hỗ trợ fetchUsage() — bỏ qua đơn ${order.order_code}`,
          );
          continue;
        }

        try {
          const { used_gb } = await provider.fetchUsage(
            (partner as any).token_api,
            order.provider_order_id,
            { metadata: (order as any).provider_metadata },
          );

          const usedGb = Math.max(0, Number(used_gb) || 0);
          const quotaGb = Number(order.bandwidth_gb) || 0;
          const isDepleted = quotaGb > 0 && usedGb >= quotaGb;

          await this.orderModel.updateOne(
            { _id: order._id },
            {
              $set: {
                bandwidth_used_gb: usedGb,
                bandwidth_synced_at: new Date(),
                ...(isDepleted ? { status: OrderStatusEnum.DEPLETED } : {}),
              },
            },
          );

          if (isDepleted) {
            void this.orderLogService.info(
              orderId,
              OrderLogStep.BANDWIDTH_DEPLETED,
              `Đơn ${order.order_code} đã dùng hết dung lượng (${usedGb}/${quotaGb} GB)`,
              { used_gb: usedGb, quota_gb: quotaGb },
            );

            // Trả lại tài nguyên cho nhà cung cấp. Provider nào tự khai không
            // huỷ được thì bỏ qua — gọi vào để nhận đúng một exception rồi ghi
            // cảnh báo mỗi lần có đơn cạn chỉ làm nhiễu log.
            if (provider.capabilities?.cancel !== false) {
              try {
                await provider.cancel({
                  token_api: (partner as any).token_api,
                  provider_order_id: order.provider_order_id,
                });
              } catch (err) {
                this.logger.warn(
                  `Không huỷ được order ${order.order_code} bên nhà cung cấp: ${(err as Error).message}`,
                );
              }
            }
          } else if (usedGb !== Number(order.bandwidth_used_gb)) {
            void this.orderLogService.info(
              orderId,
              OrderLogStep.BANDWIDTH_SYNCED,
              `Cập nhật dung lượng: ${usedGb}/${quotaGb} GB`,
              { used_gb: usedGb, quota_gb: quotaGb },
            );
          }
        } catch (err) {
          // Một đơn lỗi không được chặn các đơn còn lại
          this.logger.error(
            `Đồng bộ dung lượng thất bại cho ${order.order_code}: ${(err as Error).message}`,
          );
        }
      }
    } finally {
      this.isRunning = false;
    }
  }
}
