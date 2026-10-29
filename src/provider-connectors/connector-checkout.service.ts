import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Order } from '../schemas/orders.schema';
import { User } from '../schemas/users.schema';
import { Service } from '../schemas/services.schema';
import { WalletTransaction, WalletTxType } from '../schemas/wallet-transaction.schema';
import { OrderStatusEnum, PaymentMethodEnum, PaymentStatusEnum } from '../enum/order.enum';
import { dispatchInputHash } from './connector-dispatch.service';

/** Durable checkout receipt + debit + order + wallet journal in ONE Mongo transaction. */
@Injectable()
export class ConnectorCheckout {
  constructor(@InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(WalletTransaction.name) private readonly wallet: Model<WalletTransaction>,
    private readonly config: ConfigService) {}

  private identity(userId: string, key: string, payload: Record<string, unknown>) {
    if (!Types.ObjectId.isValid(userId) || typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key required for Connector purchase');
    }
    return { key: createHash('sha256').update(`${new Types.ObjectId(userId).toHexString()}:${key}`).digest('hex'),
      hash: dispatchInputHash(payload) };
  }

  async replay(userId: string, key: string, payload: Record<string, unknown>) {
    const identity = this.identity(userId, key, payload);
    const row = await this.orders.findOne({ connector_checkout_key: identity.key, user_id: new Types.ObjectId(userId) })
      .select('+connector_checkout_hash +connector_checkout_response').lean().exec();
    if (!row) return null;
    if (row.connector_checkout_hash !== identity.hash) throw new ConflictException('Checkout idempotency payload mismatch');
    if (!row.connector_checkout_response) throw new ConflictException('Checkout receipt unavailable; reconcile before retrying');
    const response = row.connector_checkout_response;
    // Mongoose minimizes empty Mixed objects on save. Keep the public receipt
    // shape identical on the first response and every durable replay.
    return { ...response, data: { ...response.data, config: response.data?.config ?? {} } };
  }

  async commit(request: { userId: string; key: string; payload: Record<string, unknown>;
    service: Service & { _id: Types.ObjectId; updatedAt?: Date }; order: Partial<Order> }) {
    const { userId, key, payload, service } = request;
    const identity = this.identity(userId, key, payload);
    const existing = await this.replay(userId, key, payload);
    if (existing) return existing;
    // Keep deployment closed until templates/migration and after-sale operations are verified.
    if (this.config.get<string>('CONNECTOR_CHECKOUT_ENABLED') !== 'true') {
      throw new ServiceUnavailableException('Thanh toán Connector chưa được kích hoạt; chưa trừ ví');
    }
    const order = request.order;
    if (!order.connector_purchase || order.voucher_snapshot || !Number.isSafeInteger(order.total_price) ||
        order.total_price! < 0 || order.pricing_mode !== 'duration') throw new BadRequestException('Invalid Connector checkout snapshot');
    const id = new Types.ObjectId();
    const session = await this.orders.db.startSession();
    let response: Record<string, any> | undefined;
    try {
      await session.withTransaction(async () => {
        response = undefined;
        // A real conditional write serializes checkout with admin price/package edits.
        const unchanged = await this.services.updateOne({ _id: service._id, updatedAt: service.updatedAt,
          status: true, api_enabled: true, connector_binding: service.connector_binding },
        { $inc: { connector_checkout_revision: 1 } }, { session, timestamps: false });
        if (unchanged.modifiedCount !== 1) throw new ConflictException('Service changed; reload before purchase');
        const user = await this.users.findOneAndUpdate({ _id: new Types.ObjectId(userId), money: { $gte: order.total_price } },
          { $inc: { money: -order.total_price! } }, { new: true, session }).lean().exec();
        if (!user) throw new BadRequestException('Số dư không đủ để mua dịch vụ này');
        const after = Number(user.money), before = after + order.total_price!;
        response = { success: true, message: 'Đặt hàng thành công, đang xử lý proxy', data: {
          order_id: String(id), order_code: order.order_code, status: OrderStatusEnum.PENDING,
          service_name: service.name, proxy_type: order.proxy_type ?? '', pricing_mode: 'duration',
          quantity: order.quantity, duration_days: order.duration_days, bandwidth_gb: null,
          start_date: null, end_date: null, price_per_unit: order.price_per_unit, total_price: order.total_price,
          balance_before: before, balance_after: after, config: order.config ?? {},
        } };
        await this.orders.create([{ ...order, _id: id, user_id: new Types.ObjectId(userId), service_id: service._id,
          status: OrderStatusEnum.PENDING, payment_status: PaymentStatusEnum.PAID, payment_method: PaymentMethodEnum.BALANCE,
          start_date: undefined, end_date: undefined, connector_checkout_key: identity.key, connector_checkout_hash: identity.hash,
          connector_checkout_response: response }], { session });
        await this.wallet.create([{ user_id: new Types.ObjectId(userId), credit_key: `connector-purchase:${id}`,
          type: WalletTxType.PURCHASE, amount: order.total_price, direction: 'out', balance_before: before,
          balance_after: after, ref_id: String(id), ref_type: 'order', created_by: 'system',
          description: `Mua proxy: ${service.name} x${order.quantity} (${order.duration_days} ngày)` }], { session });
      });
      return response!;
    } catch (error) {
      // Concurrent same-key winners or unknown commit acknowledgement: read the durable receipt.
      const committed = await this.replay(userId, key, payload);
      if (committed) return committed;
      throw error;
    } finally { await session.endSession(); }
  }
}
