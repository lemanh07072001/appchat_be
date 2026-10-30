import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Order } from '../schemas/orders.schema';
import { Proxy } from '../schemas/proxies.schema';
import { Service } from '../schemas/services.schema';
import { User } from '../schemas/users.schema';
import { WalletTransaction, WalletTxType } from '../schemas/wallet-transaction.schema';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';
import { ConnectorAccount } from './connector-account.schema';
import { ConnectorSecrets } from './connector-secrets.service';
import { ProviderConnectorsService } from './provider-connectors.service';
import { ConnectorDispatches, dispatchInputHash } from './connector-dispatch.service';
import { ConnectorHttp } from './connector-http.service';
import { ConnectorWriteExecutor, preflightConnectorWrite } from './connector-write-executor';

/**
 * Gia hạn đơn Connector: trả tiền trước trong một transaction, gửi upstream sau, chỉ nới hạn
 * khi nhà cung cấp xác nhận. Không có pha giao proxy vì gia hạn không cấp proxy mới.
 *
 * Một đơn chỉ có một lượt gia hạn ĐANG CHẠY; gia hạn xong thì `connector_renewal_state` về
 * null để chu kỳ sau còn gia hạn lại được. Kết quả mơ hồ đi vào `reconciliation` và dừng ở đó:
 * không tự gọi lại, không tự hoàn ví — tiền đã trừ và lệnh có thể đã tới nhà cung cấp.
 */
@Injectable()
export class ConnectorOrderRenewal {
  constructor(@InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Proxy.name) private readonly proxies: Model<Proxy>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(WalletTransaction.name) private readonly wallet: Model<WalletTransaction>,
    @InjectModel(ConnectorAccount.name) private readonly accounts: Model<ConnectorAccount>,
    private readonly connectors: ProviderConnectorsService, private readonly secrets: ConnectorSecrets,
    private readonly dispatches: ConnectorDispatches, private readonly http: ConnectorHttp,
    private readonly config: ConfigService) {}

  private identity(userId: string, key: string, payload: Record<string, unknown>) {
    if (!Types.ObjectId.isValid(userId) || typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key required for Connector renewal');
    }
    return { key: createHash('sha256').update(`renew:${new Types.ObjectId(userId).toHexString()}:${key}`).digest('hex'),
      hash: dispatchInputHash(payload) };
  }

  /**
   * Đường gia hạn của đơn này. Chỉ đọc và rẻ: controller không được đoán, vì hai luồng gia hạn
   * (nhà cung cấp cũ và Connector) dùng chung một route.
   */
  async mode(userId: string, orderId: string): Promise<'connector' | 'legacy'> {
    if (!Types.ObjectId.isValid(orderId) || !Types.ObjectId.isValid(userId)) return 'legacy';
    const row = await this.orders.findOne({ _id: orderId, user_id: new Types.ObjectId(userId) })
      .select('connector_purchase').lean().exec();
    return row?.connector_purchase ? 'connector' : 'legacy';
  }

  /** Durable answer for a repeated key. Never re-sends and never re-debits. */
  async replay(userId: string, key: string, payload: Record<string, unknown>) {
    const identity = this.identity(userId, key, payload);
    const owner = new Types.ObjectId(userId);
    const row = await this.orders.findOne({ connector_renewal_key: identity.key, user_id: owner })
      .select('+connector_renewal_hash connector_renewal connector_renewal_state end_date order_code').lean().exec();
    if (row) {
      if (row.connector_renewal_hash !== identity.hash) throw new ConflictException('Renewal idempotency payload mismatch');
      return { order_code: row.order_code, state: row.connector_renewal_state ?? 'renewed',
        duration_days: row.connector_renewal?.input.durationDays ?? null,
        price: row.connector_renewal?.price ?? null, end_date: row.end_date ?? null };
    }
    // Khoá của một lượt gia hạn cũ hơn: không còn biên nhận để trả lời, nhưng tuyệt đối không
    // được xử như yêu cầu mới — đó đúng là lúc ví bị trừ lần hai cho cùng một lần bấm.
    const used = await this.orders.findOne({ connector_renewal_keys: identity.key, user_id: owner })
      .select('_id').lean().exec();
    if (used) throw new ConflictException('Idempotency-Key này đã dùng cho một lượt gia hạn trước');
    return null;
  }

  /**
   * Vì sao đơn chưa gia hạn được, hoặc null nếu được. Một chỗ duy nhất để báo giá và lượt
   * gia hạn thật đọc cùng một luật — báo giá nói được thì gia hạn mới chạy.
   */
  private stateReason(order: Order): string | null {
    if (order.voucher_snapshot || order.payment_status !== PaymentStatusEnum.PAID ||
        ![OrderStatusEnum.ACTIVE, OrderStatusEnum.PARTIAL].includes(order.status) ||
        order.connector_purchase_state !== 'delivered') {
      return 'Đơn chưa ở trạng thái gia hạn được';
    }
    if (order.connector_renewal_state === 'dispatching') return 'Lượt gia hạn trước đang chạy; chờ kết quả';
    if (order.connector_renewal_state) return 'Lượt gia hạn trước cần đối soát; liên hệ hỗ trợ';
    const end = order.end_date instanceof Date ? order.end_date : null;
    if (!end || !Number.isFinite(end.getTime()) || end.getTime() <= Date.now()) {
      return 'Đơn đã hết hạn hoặc thiếu hạn dùng; hãy đặt đơn mới';
    }
    return null;
  }

  /**
   * Gia hạn đúng những proxy đơn còn giữ, hoặc không gia hạn gì: danh sách thiếu sẽ thu tiền
   * cả đơn mà vẫn để số proxy còn lại hết hạn.
   */
  private async inventory(order: { _id: Types.ObjectId; quantity: number; actual_quantity?: number | null }) {
    const rows = await this.proxies.find({ order_id: order._id, deleted_at: null })
      .select('provider_proxy_id').limit(1001).lean().exec();
    const providerProxyIds = rows.map(row => Number(row.provider_proxy_id));
    const expected = order.actual_quantity ?? order.quantity;
    if (!rows.length || rows.length > 1000 || rows.length !== expected ||
        providerProxyIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(providerProxyIds).size !== providerProxyIds.length) {
      return { providerProxyIds: [] as number[], count: rows.length,
        reason: 'Danh sách proxy của đơn chưa đủ để gia hạn; cần đối soát trước' };
    }
    return { providerProxyIds, count: rows.length, reason: null as string | null };
  }

  /** Các mốc thời hạn dịch vụ đang bán, kèm giá server sẽ tính cho đúng số proxy của đơn. */
  private quotes(service: Service | null, count: number) {
    const pricing = (service?.pricing ?? {}) as Record<string, { price?: number }>;
    return Object.keys(pricing)
      .map(days => ({ duration_days: Number(days), unit_price: pricing[days]?.price as number }))
      .filter(row => Number.isSafeInteger(row.duration_days) && row.duration_days >= 1 && row.duration_days <= 3650 &&
        Number.isSafeInteger(row.unit_price) && row.unit_price >= 0)
      .sort((a, b) => a.duration_days - b.duration_days)
      .map(row => ({ ...row, price: row.unit_price * count }));
  }

  /** Thứ tự lý do giống y luồng gia hạn thật: cờ, trạng thái đơn, kết nối, dịch vụ, proxy. */
  private async reasonNotRenewable(order: Order, binding: NonNullable<Order['connector_purchase']>,
    service: Service | null, inventoryReason: string | null, quoteCount: number) {
    if (this.config.get<string>('CONNECTOR_RENEWAL_ENABLED') !== 'true') {
      return 'Gia hạn qua nhà cung cấp đang tạm khoá';
    }
    const stateReason = this.stateReason(order);
    if (stateReason) return stateReason;
    const account = await this.accounts.findById(binding.accountId)
      .select('enabled connectorCode connectorVersion').lean().exec();
    if (!account?.enabled || account.connectorCode !== binding.connectorCode ||
        account.connectorVersion !== binding.connectorVersion) {
      return 'Kết nối nhà cung cấp của đơn này không còn khả dụng';
    }
    const definition = await this.connectors.publishedDefinition(binding.connectorCode, binding.connectorVersion);
    const renew = definition?.actions.renew;
    if (!definition || !renew || !('operation' in renew)) {
      return 'Đơn này nằm trên phiên bản kết nối chưa gia hạn được; hãy đặt đơn mới';
    }
    if (!service || service.pricing_mode !== 'duration' || !service.connector_binding ||
        service.connector_binding.connectorCode !== binding.connectorCode) {
      return 'Dịch vụ không còn bán theo thời hạn của nhà cung cấp này';
    }
    // Công tắc gia hạn của admin: giống đường nhà cung cấp cũ, tắt là tắt cho cả hai.
    if (service.allow_renew === false) return 'Dịch vụ này không hỗ trợ gia hạn';
    if (inventoryReason) return inventoryReason;
    if (!quoteCount) return 'Dịch vụ chưa niêm yết mốc thời hạn nào để gia hạn';
    return null;
  }

  /**
   * Báo giá gia hạn. Chỉ đọc, không trừ ví: hộp thoại hiện đúng giá server sẽ tính, và nêu lý
   * do khi chưa gia hạn được thay vì để khách bấm rồi nhận lỗi.
   */
  async options(userId: string, orderId: string) {
    if (!Types.ObjectId.isValid(orderId) || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid order ID');
    }
    const order = await this.orders.findOne({ _id: orderId, user_id: new Types.ObjectId(userId) }).lean().exec();
    const binding = order?.connector_purchase;
    if (!order || !binding) throw new NotFoundException('Không tìm thấy đơn Connector của bạn');

    const [inventory, service] = await Promise.all([
      this.inventory(order),
      this.services.findById(order.service_id).lean().exec(),
    ]);
    const quotes = this.quotes(service as Service | null, inventory.providerProxyIds.length);
    const reason = await this.reasonNotRenewable(order as Order, binding, service as Service | null,
      inventory.reason, quotes.length);
    // `count` chứ không phải số id đọc được: đơn có proxy mà thiếu id upstream thì phải hiện
    // đúng số proxy khách đang giữ, kèm lý do, không phải hiện 0 proxy.
    return { mode: 'connector' as const, enabled: !reason, reason, proxy_count: inventory.count,
      end_date: order.end_date ?? null, options: reason ? [] : quotes };
  }

  async renew(request: { userId: string; orderId: string; durationDays: number; key: string }) {
    const { userId, orderId, durationDays, key } = request;
    if (!Types.ObjectId.isValid(orderId)) throw new BadRequestException('Invalid order ID');
    if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
      throw new BadRequestException('Số ngày gia hạn không hợp lệ; chưa trừ ví');
    }
    const payload = { orderId: new Types.ObjectId(orderId).toHexString(), durationDays };
    const identity = this.identity(userId, key, payload);
    const existing = await this.replay(userId, key, payload);
    if (existing) return existing;
    // Deployment gate stays separate from purchase: opening sales must not open renewal.
    if (this.config.get<string>('CONNECTOR_RENEWAL_ENABLED') !== 'true') {
      throw new ServiceUnavailableException('Gia hạn Connector chưa được kích hoạt; chưa trừ ví');
    }

    const order = await this.orders.findOne({ _id: orderId, user_id: new Types.ObjectId(userId) }).lean().exec();
    const binding = order?.connector_purchase;
    if (!order || !binding) throw new NotFoundException('Không tìm thấy đơn Connector của bạn');
    const stateReason = this.stateReason(order as Order);
    if (stateReason) throw new ConflictException(`${stateReason}; chưa trừ ví`);
    const previousEndDate = order.end_date as Date;

    // The order's own pinned version decides the contract, not whatever the service sells today.
    const account = await this.accounts.findById(binding.accountId).select('+credential').lean().exec();
    if (!account?.enabled || account.connectorCode !== binding.connectorCode ||
        account.connectorVersion !== binding.connectorVersion) {
      throw new ConflictException('Kết nối nhà cung cấp của đơn này không còn khả dụng; chưa trừ ví');
    }
    const definition = await this.connectors.publishedDefinition(binding.connectorCode, binding.connectorVersion);
    const renew = definition?.actions.renew;
    if (!definition || !renew || !('operation' in renew)) {
      throw new ConflictException('Phiên bản kết nối của đơn này không hỗ trợ gia hạn; hãy đặt đơn mới');
    }

    const service = await this.services.findById(order.service_id).lean().exec();
    if (!service || service.pricing_mode !== 'duration' || !service.connector_binding ||
        service.connector_binding.connectorCode !== binding.connectorCode) {
      throw new ConflictException('Dịch vụ không còn bán theo thời hạn của nhà cung cấp này; chưa trừ ví');
    }
    if (service.allow_renew === false) throw new ConflictException('Dịch vụ này không hỗ trợ gia hạn; chưa trừ ví');
    const tier = (service.pricing ?? {})[String(durationDays)];
    const unitPrice = tier?.price;
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
      throw new BadRequestException('Dịch vụ không bán mốc thời hạn này; chưa trừ ví');
    }

    const inventory = await this.inventory(order);
    if (inventory.reason) throw new ConflictException(inventory.reason);
    const providerProxyIds = inventory.providerProxyIds;
    const price = unitPrice * providerProxyIds.length;
    if (!Number.isSafeInteger(price) || price < 0) throw new BadRequestException('Giá gia hạn không hợp lệ; chưa trừ ví');

    const input = { providerProxyIds, durationDays };
    dispatchInputHash(input);
    const token = this.secrets.decrypt(account.credential, new Types.ObjectId(binding.accountId).toHexString());
    // Local mapping/credential problems must fail before the debit, not after.
    preflightConnectorWrite(definition, 'renew', input, token);

    const snapshot = { accountId: binding.accountId, connectorCode: binding.connectorCode,
      connectorVersion: binding.connectorVersion, input, price, previousEndDate };
    const session = await this.orders.db.startSession();
    try {
      await session.withTransaction(async () => {
        const claimed = await this.orders.updateOne({ _id: order._id, status: order.status,
          payment_status: PaymentStatusEnum.PAID, connector_purchase_state: 'delivered',
          connector_renewal_state: null, end_date: previousEndDate,
          connector_purchase: binding }, { $set: { connector_renewal: snapshot,
          connector_renewal_state: 'dispatching', connector_renewal_key: identity.key,
          connector_renewal_hash: identity.hash },
        $addToSet: { connector_renewal_keys: identity.key } }, { session });
        if (claimed.modifiedCount !== 1) throw new ConflictException('Đơn vừa thay đổi; tải lại trước khi gia hạn');
        const user = await this.users.findOneAndUpdate({ _id: new Types.ObjectId(userId), money: { $gte: price } },
          { $inc: { money: -price } }, { new: true, session }).lean().exec();
        if (!user) throw new BadRequestException('Số dư không đủ để gia hạn đơn này');
        const after = Number(user.money), before = after + price;
        await this.wallet.create([{ user_id: new Types.ObjectId(userId), credit_key: `connector-renewal:${identity.key}`,
          type: WalletTxType.RENEW, amount: price, direction: 'out', balance_before: before, balance_after: after,
          ref_id: String(order._id), ref_type: 'order', created_by: 'system',
          description: `Gia hạn proxy: ${service.name} x${providerProxyIds.length} (${durationDays} ngày)` }], { session });
      });
    } finally { await session.endSession(); }

    const end = new Date(previousEndDate.getTime() + durationDays * 86400_000);
    try {
      const executor = new ConnectorWriteExecutor(this.dispatches, this.http);
      await executor.execute({ identity: { reference: `renew:${orderId.toLowerCase()}:${identity.key.slice(0, 16)}`,
        orderId, accountId: binding.accountId, connectorCode: binding.connectorCode,
        connectorVersion: binding.connectorVersion, action: 'renew' }, definition, input, token,
        persistResult: async () => {
          // The provider extends from the old expiry, not from now, so mirror that exactly.
          // Trạng thái về null: lượt này đã xong, chu kỳ sau đơn lại gia hạn được.
          const saved = await this.orders.updateOne({ _id: order._id, connector_renewal_state: 'dispatching',
            connector_renewal: snapshot, end_date: previousEndDate },
          { $set: { connector_renewal_state: null, end_date: end, last_renewed_at: new Date(),
            last_renewed_by: 'user', is_renewed: true, error_message: '' }, $inc: { renew_count: 1 } });
          if (saved.modifiedCount !== 1) throw new ConflictException('Renewal projection changed');
        } });
      return { order_code: order.order_code, state: 'renewed', duration_days: durationDays, price, end_date: end };
    } catch {
      // Paid and possibly delivered upstream: hold the fence for an operator, never auto-refund.
      await this.orders.updateOne({ _id: order._id, connector_renewal_state: 'dispatching' },
        { $set: { connector_renewal_state: 'reconciliation',
          error_message: 'Gia hạn nhà cung cấp cần đối soát; không tự gia hạn lại hoặc hoàn tiền.' } });
      throw new ConflictException('Gia hạn cần đối soát; đã trừ ví và không tự hoàn');
    }
  }
}
