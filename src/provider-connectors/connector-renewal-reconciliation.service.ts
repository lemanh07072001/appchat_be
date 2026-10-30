import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order } from '../schemas/orders.schema';
import { Service } from '../schemas/services.schema';
import { User } from '../schemas/users.schema';
import { WalletTransaction, WalletTxType } from '../schemas/wallet-transaction.schema';
import { ConnectorDispatch } from './connector-dispatch.schema';

export type RenewalOutcome = 'extended' | 'not-extended';

/**
 * Đối soát những lượt gia hạn treo (`connector_renewal_state: 'reconciliation'`).
 *
 * Hệ thống KHÔNG tự đoán được lệnh đã tới nhà cung cấp hay chưa — đó đúng là lý do nó dừng lại.
 * Người vận hành tự đối chiếu với nhà cung cấp rồi khai kết quả kèm bằng chứng; mỗi lượt chỉ
 * được chốt một lần (chặn bằng chính `connector_renewal_state`, và khoá hoàn tiền duy nhất).
 */
@Injectable()
export class ConnectorRenewalReconciliation {
  constructor(@InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(WalletTransaction.name) private readonly wallet: Model<WalletTransaction>,
    @InjectModel(ConnectorDispatch.name) private readonly dispatches: Model<ConnectorDispatch>) {}

  /** Mọi thứ người vận hành cần để tự đối chiếu, không có gì bí mật của nhà cung cấp. */
  async pending() {
    const rows = await this.orders.find({ connector_renewal_state: 'reconciliation' })
      .select('order_code user_id service_id connector_renewal end_date renew_count error_message updatedAt')
      .sort({ updatedAt: 1 }).limit(200).lean().exec();
    if (!rows.length) return { total: 0, items: [] };

    const [users, services, dispatches] = await Promise.all([
      this.users.find({ _id: { $in: rows.map(row => row.user_id) } }).select('email').lean().exec(),
      this.services.find({ _id: { $in: rows.map(row => row.service_id) } }).select('name').lean().exec(),
      this.dispatches.find({ orderId: { $in: rows.map(row => String(row._id)) }, action: 'renew' })
        .select('orderId reference status submittedAt completedAt createdAt').sort({ createdAt: -1 }).lean().exec(),
    ]);
    const email = new Map(users.map(row => [String(row._id), row.email]));
    const serviceName = new Map(services.map(row => [String(row._id), row.name]));
    const dispatch = new Map<string, (typeof dispatches)[number]>();
    for (const row of dispatches) if (!dispatch.has(row.orderId)) dispatch.set(row.orderId, row);

    return { total: rows.length, items: rows.map(row => {
      const sent = row.connector_renewal;
      const last = dispatch.get(String(row._id));
      return { order_id: String(row._id), order_code: row.order_code,
        user: { id: String(row.user_id), email: email.get(String(row.user_id)) ?? null },
        service: serviceName.get(String(row.service_id)) ?? null,
        connector: sent ? `${sent.connectorCode} v${sent.connectorVersion}` : null,
        price: sent?.price ?? null, duration_days: sent?.input.durationDays ?? null,
        provider_proxy_ids: sent?.input.providerProxyIds ?? [],
        previous_end_date: sent?.previousEndDate ?? null, end_date: row.end_date ?? null,
        renew_count: row.renew_count ?? 0, message: row.error_message || null,
        dispatch: last ? { reference: last.reference, status: last.status,
          submitted_at: last.submittedAt ?? null, completed_at: last.completedAt ?? null } : null,
        stuck_since: (row as { updatedAt?: Date }).updatedAt ?? null };
    }) };
  }

  /**
   * Chốt một lượt treo. `extended` = đã xác minh nhà cung cấp GIA HẠN rồi → nới hạn đúng mốc cũ
   * cộng số ngày đã gửi, không trừ thêm tiền. `not-extended` = đã xác minh KHÔNG gia hạn → hoàn
   * lại đúng số tiền đã trừ, hạn dùng giữ nguyên. Không có đường nào vừa nới hạn vừa hoàn tiền.
   */
  async resolve(orderId: string, review: { outcome: RenewalOutcome; evidence: string; actor: string }) {
    if (!Types.ObjectId.isValid(orderId)) throw new BadRequestException('Invalid order ID');
    const evidence = review.evidence?.trim() ?? '';
    if (evidence.length < 10 || evidence.length > 500) {
      throw new BadRequestException('Bằng chứng đối soát phải từ 10 đến 500 ký tự');
    }
    const order = await this.orders.findById(orderId)
      .select('+connector_renewal_key order_code user_id connector_renewal connector_renewal_state end_date').lean().exec();
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    const sent = order.connector_renewal;
    if (order.connector_renewal_state !== 'reconciliation' || !sent) {
      throw new ConflictException('Đơn này không có lượt gia hạn nào đang treo');
    }
    const key = (order as { connector_renewal_key?: string }).connector_renewal_key;
    if (!key) throw new ConflictException('Lượt gia hạn thiếu khoá đối soát; cần xem lại bằng tay');
    const previousEndDate = sent.previousEndDate instanceof Date ? sent.previousEndDate : new Date(sent.previousEndDate);
    const stamp = { actor: review.actor, outcome: review.outcome, evidence, at: new Date(),
      price: sent.price, durationDays: sent.input.durationDays };

    if (review.outcome === 'extended') {
      const end = new Date(previousEndDate.getTime() + sent.input.durationDays * 86400_000);
      const saved = await this.orders.updateOne({ _id: order._id, connector_renewal_state: 'reconciliation',
        end_date: previousEndDate }, { $set: { connector_renewal_state: null, end_date: end,
        last_renewed_at: new Date(), last_renewed_by: 'admin', is_renewed: true, error_message: '',
        connector_renewal_review: stamp }, $inc: { renew_count: 1 } });
      if (saved.modifiedCount !== 1) throw new ConflictException('Đơn vừa thay đổi; tải lại trước khi chốt');
      return { order_code: order.order_code, outcome: stamp.outcome, end_date: end, refunded: 0 };
    }

    // Hoàn tiền: `refunded_amount` của đơn giữ nguyên — nó là sổ hoàn tiền của lần MUA, còn đây
    // là tiền của một lượt gia hạn không thành. Dấu vết nằm ở sổ ví với khoá hoàn tiền duy nhất.
    const price = Number(sent.price);
    if (!Number.isSafeInteger(price) || price < 0) throw new ConflictException('Số tiền đã trừ không đọc được; cần xem lại bằng tay');
    const session = await this.orders.db.startSession();
    try {
      await session.withTransaction(async () => {
        const released = await this.orders.updateOne({ _id: order._id, connector_renewal_state: 'reconciliation' },
          { $set: { connector_renewal_state: null, error_message: '', connector_renewal_review: stamp } }, { session });
        if (released.modifiedCount !== 1) throw new ConflictException('Đơn vừa thay đổi; tải lại trước khi chốt');
        if (!price) return;
        const user = await this.users.findOneAndUpdate({ _id: order.user_id }, { $inc: { money: price } },
          { new: true, session }).lean().exec();
        if (!user) throw new ConflictException('Không tìm thấy tài khoản để hoàn tiền');
        const after = Number(user.money), before = after - price;
        await this.wallet.create([{ user_id: order.user_id, credit_key: `connector-renewal-refund:${key}`,
          type: WalletTxType.REFUND, amount: price, direction: 'in', balance_before: before, balance_after: after,
          ref_id: String(order._id), ref_type: 'order', created_by: review.actor,
          description: `Hoàn tiền gia hạn không thành: ${order.order_code}` }], { session });
      });
    } finally { await session.endSession(); }
    return { order_code: order.order_code, outcome: stamp.outcome, end_date: order.end_date ?? null, refunded: price };
  }
}
