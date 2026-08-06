import * as mongoose from 'mongoose';
import {
  AffiliateCommissionSchema,
  AffiliateCommissionStatus,
} from '../../schemas/affiliate-commission.schema';
import { AffiliateConfigSchema } from '../../schemas/affiliate-config.schema';
import { WithdrawalSchema, WithdrawalStatus } from '../../schemas/withdrawal.schema';
import { OrderSchema } from '../../schemas/orders.schema';
import { UserSchema } from '../../schemas/users.schema';
import { OrderStatusEnum, PaymentStatusEnum } from '../../enum/order.enum';
import { emptyResult, forceTimestamps, SeedResult } from '../lib/db';

const Commission =
  mongoose.models.CommissionSeed ||
  mongoose.model('CommissionSeed', AffiliateCommissionSchema, 'affiliatecommissions');
const Config =
  mongoose.models.AffiliateConfigSeed ||
  mongoose.model('AffiliateConfigSeed', AffiliateConfigSchema, 'affiliateconfigs');
const Withdrawal =
  mongoose.models.WithdrawalSeed ||
  mongoose.model('WithdrawalSeed', WithdrawalSchema, 'withdrawals');
const Order =
  mongoose.models.OrderSeedAff || mongoose.model('OrderSeedAff', OrderSchema, 'orders');
const User = mongoose.models.UserSeedAff || mongoose.model('UserSeedAff', UserSchema, 'users');

const COMMISSION_RATE = 10;

const BANKS = [
  { bank_name: 'Vietcombank', bank_account: '0071000512345' },
  { bank_name: 'MB Bank', bank_account: '0904112233' },
  { bank_name: 'Techcombank', bank_account: '19033445566012' },
  { bank_name: 'ACB', bank_account: '2450778899' },
  { bank_name: 'VPBank', bank_account: '188866554433' },
];

/** Đơn đã hết hiệu lực → hoa hồng đủ điều kiện; đơn còn chạy → pending; đơn hỏng → cancelled */
function statusForOrder(orderStatus: number): AffiliateCommissionStatus {
  switch (orderStatus) {
    case OrderStatusEnum.CANCELLED:
    case OrderStatusEnum.FAILED:
    case OrderStatusEnum.REFUNDED:
      return AffiliateCommissionStatus.CANCELLED;
    case OrderStatusEnum.EXPIRED:
    case OrderStatusEnum.COMPLETED:
    case OrderStatusEnum.PARTIAL_REFUNDED:
    case OrderStatusEnum.PENDING_REFUND:
      return AffiliateCommissionStatus.CONFIRMED;
    default:
      return AffiliateCommissionStatus.PENDING;
  }
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 24 * 60 * 60 * 1000);

export async function seedAffiliate(): Promise<SeedResult> {
  const result = emptyResult();

  // ─── 1. Config (getConfig() cũng tự tạo, seed trước cho chắc) ────────────
  if (!(await Config.findOne().lean().exec())) {
    await Config.create({ commission_rate: COMMISSION_RATE, is_active: true });
    result.created++;
  } else {
    result.skipped++;
  }

  // ─── 2. Thông tin ngân hàng cho referrer ─────────────────────────────────
  const referredUsers = await User.find({ referred_by: { $ne: null } })
    .select('_id referred_by')
    .lean()
    .exec();

  if (referredUsers.length === 0) {
    return result;
  }

  const referrerIds = [
    ...new Set(referredUsers.map((u: any) => String(u.referred_by))),
  ].sort();

  for (let i = 0; i < referrerIds.length; i++) {
    const bank = BANKS[i % BANKS.length];
    const referrer = await User.findById(referrerIds[i]).select('name bank_account').lean().exec();
    if (!referrer) continue;
    if ((referrer as any).bank_account) {
      result.skipped++;
      continue;
    }
    await User.updateOne(
      { _id: referrerIds[i] },
      {
        bank_name: bank.bank_name,
        // Mỗi referrer một số tài khoản khác nhau
        bank_account: bank.bank_account.slice(0, -2) + String(10 + i).slice(-2),
        bank_owner: String((referrer as any).name || 'CHU TAI KHOAN').toUpperCase(),
      },
    ).exec();
    result.updated++;
  }

  // ─── 3. Commission suy từ đơn hàng thật ─────────────────────────────────
  const referrerOf = new Map<string, string>(
    referredUsers.map((u: any) => [String(u._id), String(u.referred_by)]),
  );

  const orders = await Order.find({
    user_id: { $in: referredUsers.map((u: any) => u._id) },
    payment_status: PaymentStatusEnum.PAID,
  })
    .select('_id user_id total_price status createdAt end_date duration_days')
    .sort({ createdAt: 1 })
    .lean()
    .exec();

  // Các commission đủ điều kiện, gom theo referrer để dựng phiếu rút ở bước 4
  const eligible = new Map<string, { id: mongoose.Types.ObjectId; amount: number; at: Date }[]>();

  for (const o of orders as any[]) {
    const referrerId = referrerOf.get(String(o.user_id));
    if (!referrerId) continue;

    const amount = Math.round((o.total_price * COMMISSION_RATE) / 100);
    const status = statusForOrder(o.status);
    const endDate: Date = o.end_date ?? addDays(o.createdAt, o.duration_days ?? 30);
    const confirmedAt = status === AffiliateCommissionStatus.PENDING ? null : endDate;

    let doc = await Commission.findOne({ order_id: o._id }).select('_id status').lean().exec();
    if (doc) {
      result.skipped++;
    } else {
      const created = await Commission.create({
        referrer_id: new mongoose.Types.ObjectId(referrerId),
        referred_user_id: o.user_id,
        order_id: o._id,
        order_total: o.total_price,
        commission_rate: COMMISSION_RATE,
        commission_amount: amount,
        status,
        confirmed_at: confirmedAt,
      });
      await forceTimestamps(Commission, { _id: created._id }, o.createdAt, confirmedAt ?? o.createdAt);
      doc = { _id: created._id, status } as any;
      result.created++;
    }

    if (status === AffiliateCommissionStatus.CONFIRMED) {
      const list = eligible.get(referrerId) ?? [];
      list.push({ id: (doc as any)._id, amount, at: endDate });
      eligible.set(referrerId, list);
    }
  }

  // ─── 4. Đẩy trạng thái: confirmed → credited → (requested | paid) ────────
  // Thứ tự referrer cố định để chạy lại cho ra cùng kết quả.
  const referrersWithEligible = [...eligible.keys()].sort();

  for (let i = 0; i < referrersWithEligible.length; i++) {
    const referrerId = referrersWithEligible[i];
    const items = (eligible.get(referrerId) ?? []).sort((a, b) => a.at.getTime() - b.at.getTime());
    if (items.length === 0) continue;

    // 2/3 số commission đủ điều kiện được admin duyệt vào ví
    const creditCount = Math.max(1, Math.floor((items.length * 2) / 3));
    const credited = items.slice(0, creditCount);

    for (const c of credited) {
      await Commission.updateOne(
        { _id: c.id, status: AffiliateCommissionStatus.CONFIRMED },
        {
          status: AffiliateCommissionStatus.CREDITED,
          credited_at: addDays(c.at, 2),
        },
      ).exec();
    }

    // Mọi referrer đều có phiếu rút, xoay vòng để phủ đủ 3 trạng thái withdrawal
    // (kể cả tài khoản demo — nếu không trang /vi/affiliate của nó sẽ trống mục rút tiền)
    const plan: WithdrawalStatus[] = [
      WithdrawalStatus.PAID,
      WithdrawalStatus.REQUESTED,
      WithdrawalStatus.REJECTED,
    ];
    const withdrawalStatus = plan[i % plan.length];
    if (!withdrawalStatus || credited.length === 0) continue;

    // Phải truyền ObjectId thật: mongoose ở bản này KHÔNG cast string cho path
    // `user_id` (chỉ `_id` mới được cast) → query bằng string luôn trả null.
    const existingWithdrawal = await Withdrawal.findOne({
      user_id: new mongoose.Types.ObjectId(referrerId),
    })
      .select('_id')
      .lean()
      .exec();
    if (existingWithdrawal) {
      result.skipped++;
      continue;
    }

    // Phiếu gộp nửa số commission đã vào ví
    const inWithdrawal = credited.slice(0, Math.max(1, Math.floor(credited.length / 2)));
    const total = inWithdrawal.reduce((s, c) => s + c.amount, 0);
    const requestedAt = addDays(inWithdrawal[inWithdrawal.length - 1].at, 5);
    const referrer: any = await User.findById(referrerId)
      .select('bank_name bank_account bank_owner')
      .lean()
      .exec();

    const w = await Withdrawal.create({
      user_id: new mongoose.Types.ObjectId(referrerId),
      total_amount: total,
      bank_name: referrer?.bank_name ?? '',
      bank_account: referrer?.bank_account ?? '',
      bank_owner: referrer?.bank_owner ?? '',
      status: withdrawalStatus,
      commission_ids: inWithdrawal.map((c) => c.id),
      requested_at: requestedAt,
      paid_at: withdrawalStatus === WithdrawalStatus.PAID ? addDays(requestedAt, 1) : null,
      rejected_at: withdrawalStatus === WithdrawalStatus.REJECTED ? addDays(requestedAt, 1) : null,
    });
    await forceTimestamps(Withdrawal, { _id: w._id }, requestedAt);
    result.created++;

    // Commission trong phiếu chuyển trạng thái theo đúng luồng của service.
    // REJECTED: service trả commission về CREDITED nên giữ nguyên.
    if (withdrawalStatus === WithdrawalStatus.REQUESTED) {
      await Commission.updateMany(
        { _id: { $in: inWithdrawal.map((c) => c.id) } },
        {
          status: AffiliateCommissionStatus.REQUESTED,
          requested_at: requestedAt,
          bank_name: referrer?.bank_name ?? '',
          bank_account: referrer?.bank_account ?? '',
          bank_owner: referrer?.bank_owner ?? '',
        },
      ).exec();
    } else if (withdrawalStatus === WithdrawalStatus.PAID) {
      await Commission.updateMany(
        { _id: { $in: inWithdrawal.map((c) => c.id) } },
        {
          status: AffiliateCommissionStatus.PAID,
          requested_at: requestedAt,
          paid_at: addDays(requestedAt, 1),
          bank_name: referrer?.bank_name ?? '',
          bank_account: referrer?.bank_account ?? '',
          bank_owner: referrer?.bank_owner ?? '',
        },
      ).exec();
    }
  }

  // ─── 5. Cân affiliate_balance ───────────────────────────────────────────
  // Bất biến của service: balance = Σ commission đang ở trạng thái CREDITED.
  // (credit → +amount; request rút → −amount + REQUESTED; approve → PAID, không đổi tiền;
  //  reject → +amount, trả về CREDITED)
  const balances = await Commission.aggregate([
    { $match: { status: AffiliateCommissionStatus.CREDITED } },
    { $group: { _id: '$referrer_id', total: { $sum: '$commission_amount' } } },
  ]).exec();

  const balanceOf = new Map<string, number>(
    balances.map((b: any) => [String(b._id), b.total]),
  );

  // Quét TẤT CẢ user, không chỉ referrer: dữ liệu cũ để lại affiliate_balance > 0
  // cho nhiều user không giới thiệu ai và không có commission nào — trang affiliate
  // sẽ hiện số dư không có lịch sử đối ứng.
  const allUsers = await User.find({}).select('_id affiliate_balance').lean().exec();

  for (const u of allUsers as any[]) {
    const target = balanceOf.get(String(u._id)) ?? 0;
    if ((u.affiliate_balance ?? 0) === target) continue;
    await User.updateOne({ _id: u._id }, { affiliate_balance: target }).exec();
    result.updated++;
  }

  return result;
}
