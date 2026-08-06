import * as mongoose from 'mongoose';
import { WalletTransactionSchema, WalletTxType } from '../../schemas/wallet-transaction.schema';
import { OrderSchema } from '../../schemas/orders.schema';
import { TransactionSchema, TransactionStatus } from '../../schemas/transactions.schema';
import { UserSchema } from '../../schemas/users.schema';
import { PaymentStatusEnum } from '../../enum/order.enum';
import { emptyResult, forceTimestamps, SeedResult } from '../lib/db';

const WalletTx =
  mongoose.models.WalletTxSeed ||
  mongoose.model('WalletTxSeed', WalletTransactionSchema, 'wallettransactions');
const Order =
  mongoose.models.OrderSeedWallet || mongoose.model('OrderSeedWallet', OrderSchema, 'orders');
const Transaction =
  mongoose.models.TransactionSeedWallet ||
  mongoose.model('TransactionSeedWallet', TransactionSchema, 'transactions');
const User =
  mongoose.models.UserSeedWallet || mongoose.model('UserSeedWallet', UserSchema, 'users');

interface Event {
  user_id: mongoose.Types.ObjectId;
  type: WalletTxType;
  amount: number;
  direction: 'in' | 'out';
  description: string;
  ref_id: string;
  ref_type: string;
  created_by: string;
  at: Date;
}

const vnd = (n: number) => n.toLocaleString('vi-VN');

export async function seedWallet(): Promise<SeedResult> {
  const result = emptyResult();
  const events: Event[] = [];

  // ─── Mua proxy + hoàn tiền, suy từ đơn hàng thật ────────────────────────
  const orders = await Order.find({ payment_status: PaymentStatusEnum.PAID })
    .select('_id user_id order_code total_price refunded_amount quantity duration_days createdAt')
    .lean()
    .exec();

  for (const o of orders as any[]) {
    events.push({
      user_id: o.user_id,
      type: WalletTxType.PURCHASE,
      amount: o.total_price,
      direction: 'out',
      description: `Mua proxy: đơn ${o.order_code} (${o.quantity} proxy × ${o.duration_days} ngày)`,
      ref_id: String(o._id),
      ref_type: 'order',
      created_by: 'system',
      at: o.createdAt,
    });

    if (o.refunded_amount > 0) {
      events.push({
        user_id: o.user_id,
        type: WalletTxType.REFUND,
        amount: o.refunded_amount,
        direction: 'in',
        description: `Hoàn tiền đơn ${o.order_code}: ${vnd(o.refunded_amount)}đ`,
        ref_id: String(o._id),
        ref_type: 'order',
        created_by: 'admin',
        // Hoàn tiền diễn ra sau khi đơn được xử lý
        at: new Date(new Date(o.createdAt).getTime() + 60 * 60 * 1000),
      });
    }
  }

  // ─── Nạp tiền, suy từ transactions đã xử lý ─────────────────────────────
  const txs = await Transaction.find({ status: TransactionStatus.PROCESSED })
    .select('transaction_id user_id transfer_amount transaction_date gateway source')
    .lean()
    .exec();

  for (const t of txs as any[]) {
    if (!t.user_id) continue;
    events.push({
      user_id: t.user_id,
      type: WalletTxType.DEPOSIT,
      amount: t.transfer_amount,
      direction: 'in',
      description:
        t.source === 'manual'
          ? `Admin nạp tay ${vnd(t.transfer_amount)}đ`
          : `Nạp tiền qua ${t.gateway}: ${vnd(t.transfer_amount)}đ`,
      ref_id: String(t.transaction_id),
      ref_type: 'bank_transaction',
      created_by: t.source === 'manual' ? 'admin' : 'webhook',
      at: t.transaction_date,
    });
  }

  // ─── Vài lệnh trừ tay của admin ─────────────────────────────────────────
  const topUsers = await User.find({ money: { $gt: 200000 } })
    .sort({ _id: 1 })
    .limit(3)
    .select('_id')
    .lean()
    .exec();

  const DEDUCTIONS = [
    { amount: 50000, reason: 'Trừ tiền proxy cấp nhầm cấu hình', days: 12 },
    { amount: 120000, reason: 'Điều chỉnh số dư sau đối soát tháng 7', days: 25 },
    { amount: 30000, reason: 'Thu hồi khuyến mãi áp dụng sai điều kiện', days: 40 },
  ];

  for (let i = 0; i < topUsers.length && i < DEDUCTIONS.length; i++) {
    const d = DEDUCTIONS[i];
    events.push({
      user_id: (topUsers[i] as any)._id,
      type: WalletTxType.DEDUCTION,
      amount: d.amount,
      direction: 'out',
      description: d.reason,
      ref_id: `ADJ-2026-${String(i + 1).padStart(3, '0')}`,
      ref_type: 'adjustment',
      created_by: 'admin',
      at: new Date(Date.now() - d.days * 24 * 60 * 60 * 1000),
    });
  }

  if (events.length === 0) return result;

  // ─── Tính balance_before/after theo dòng thời gian của từng user ────────
  const byUser = new Map<string, Event[]>();
  for (const e of events) {
    const k = String(e.user_id);
    const list = byUser.get(k) ?? [];
    list.push(e);
    byUser.set(k, list);
  }

  const users = await User.find({ _id: { $in: [...byUser.keys()] } })
    .select('_id money')
    .lean()
    .exec();
  const moneyOf = new Map(users.map((u: any) => [String(u._id), u.money ?? 0]));

  for (const [userId, list] of byUser) {
    list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    const net = list.reduce((s, e) => s + (e.direction === 'in' ? e.amount : -e.amount), 0);
    // Chuỗi số dư kết thúc đúng bằng users.money hiện tại. Nếu lịch sử suy ra
    // âm hơn số dư (dữ liệu cũ không đủ để dựng lại), bắt đầu từ 0 thay vì để
    // số dư âm — chuỗi vẫn liền mạch, chỉ không chạm đúng money.
    let balance = Math.max(0, (moneyOf.get(userId) ?? 0) - net);

    for (const e of list) {
      const before = balance;
      const after = e.direction === 'in' ? before + e.amount : Math.max(0, before - e.amount);
      balance = after;

      const exists = await WalletTx.findOne({ ref_id: e.ref_id, type: e.type })
        .select('_id')
        .lean()
        .exec();
      if (exists) {
        result.skipped++;
        continue;
      }

      const created = await WalletTx.create({
        user_id: e.user_id,
        type: e.type,
        amount: e.amount,
        direction: e.direction,
        balance_before: before,
        balance_after: after,
        description: e.description,
        ref_id: e.ref_id,
        ref_type: e.ref_type,
        created_by: e.created_by,
      });
      await forceTimestamps(WalletTx, { _id: created._id }, new Date(e.at));
      result.created++;
    }
  }

  return result;
}
