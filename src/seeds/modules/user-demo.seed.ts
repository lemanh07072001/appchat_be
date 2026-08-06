import * as mongoose from 'mongoose';
import { UserSchema } from '../../schemas/users.schema';
import { OrderSchema } from '../../schemas/orders.schema';
import { ProxySchema } from '../../schemas/proxies.schema';
import { OrderLogSchema, OrderLogLevel, OrderLogStep } from '../../schemas/order-log.schema';
import { ServiceSchema } from '../../schemas/services.schema';
import { ChatMessageSchema } from '../../schemas/chat-message.schema';
import {
  PaymentMethod,
  TransactionSchema,
  TransactionStatus,
} from '../../schemas/transactions.schema';
import {
  OrderStatusEnum,
  PaymentMethodEnum,
  PaymentStatusEnum,
} from '../../enum/order.enum';
import { UserRoleEnum } from '../../enum/user.enum';
import { HealthStatusEnum, ProxyProtocolEnum } from '../../enum/proxy.enum';
import { daysAgo, emptyResult, forceTimestamps, rng, SeedResult } from '../lib/db';

const User = mongoose.models.UserSeedDemo || mongoose.model('UserSeedDemo', UserSchema, 'users');
const Order =
  mongoose.models.OrderSeedDemo || mongoose.model('OrderSeedDemo', OrderSchema, 'orders');
const Proxy =
  mongoose.models.ProxySeedDemo || mongoose.model('ProxySeedDemo', ProxySchema, 'proxies');
const OrderLog =
  mongoose.models.OrderLogSeedDemo ||
  mongoose.model('OrderLogSeedDemo', OrderLogSchema, 'order_logs');
const Service =
  mongoose.models.ServiceSeedDemo ||
  mongoose.model('ServiceSeedDemo', ServiceSchema, 'services');
const Transaction =
  mongoose.models.TransactionSeedDemo ||
  mongoose.model('TransactionSeedDemo', TransactionSchema, 'transactions');
const ChatMessage =
  mongoose.models.ChatMessageSeedDemo ||
  mongoose.model('ChatMessageSeedDemo', ChatMessageSchema, 'chatmessages');

export const DEMO_EMAIL = 'user@fastproxyvn.com';

/** Số referral gán cho tài khoản demo để trang affiliate có downline */
const REFERRAL_COUNT = 5;

const ORDER_PREFIX = 'ORD-DEMO-';
const TX_ID_BASE = 960001;

interface OrderPlan {
  suffix: string;
  serviceName: string;
  quantity: number;
  duration: number;
  status: OrderStatusEnum;
  daysOld: number;
  /** số proxy thực nhận, mặc định = quantity */
  actualQuantity?: number;
  refunded?: number;
  bandwidthGb?: number;
  errorMessage?: string;
  autoRenew?: boolean;
}

const ORDERS: OrderPlan[] = [
  { suffix: 'A1', serviceName: 'Proxy IPV4 Private', quantity: 5, duration: 30, status: OrderStatusEnum.ACTIVE, daysOld: 12, autoRenew: true },
  { suffix: 'A2', serviceName: 'Proxy Ngoại (US)', quantity: 2, duration: 30, status: OrderStatusEnum.ACTIVE, daysOld: 6 },
  { suffix: 'A3', serviceName: 'Proxy IPV6 Private', quantity: 10, duration: 7, status: OrderStatusEnum.ACTIVE, daysOld: 3 },
  { suffix: 'R1', serviceName: 'Proxy IPV4 Xoay', quantity: 1, duration: 30, status: OrderStatusEnum.ACTIVE, daysOld: 9, bandwidthGb: 50 },
  { suffix: 'R2', serviceName: 'Proxy IPV6 Xoay Key', quantity: 1, duration: 7, status: OrderStatusEnum.EXPIRED, daysOld: 40, bandwidthGb: 20 },
  { suffix: 'E1', serviceName: 'Proxy IPV4 Private', quantity: 3, duration: 30, status: OrderStatusEnum.EXPIRED, daysOld: 75 },
  { suffix: 'C1', serviceName: 'Proxy IPV4 Private', quantity: 4, duration: 7, status: OrderStatusEnum.COMPLETED, daysOld: 55 },
  { suffix: 'P1', serviceName: 'Proxy IPV6 Private', quantity: 8, duration: 30, status: OrderStatusEnum.PROCESSING, daysOld: 0.05 },
  { suffix: 'W1', serviceName: 'Proxy Ngoại (US)', quantity: 1, duration: 1, status: OrderStatusEnum.PENDING, daysOld: 0.02 },
  { suffix: 'X1', serviceName: 'Proxy IPV4 Xoay', quantity: 1, duration: 7, status: OrderStatusEnum.CANCELLED, daysOld: 30, bandwidthGb: 10 },
  { suffix: 'F1', serviceName: 'Proxy IPV6 Private', quantity: 6, duration: 30, status: OrderStatusEnum.FAILED, daysOld: 21, errorMessage: 'Provider trả về lỗi: out of stock cho dải IPv6 yêu cầu' },
  { suffix: 'M1', serviceName: 'Proxy IPV4 Private', quantity: 10, duration: 30, status: OrderStatusEnum.PARTIAL, daysOld: 18, actualQuantity: 7 },
  { suffix: 'H1', serviceName: 'Proxy Ngoại (US)', quantity: 3, duration: 30, status: OrderStatusEnum.PARTIAL_REFUNDED, daysOld: 47, actualQuantity: 2, refunded: 56000 },
];

interface DepositPlan {
  offset: number;
  gateway: string;
  amount: number;
  status: TransactionStatus;
  source: 'auto' | 'manual';
  note: string;
  daysOld: number;
  method?: PaymentMethod;
  cryptoAmount?: number;
  txHash?: string;
}

const DEPOSITS: DepositPlan[] = [
  { offset: 0, gateway: 'VCB', amount: 2000000, status: TransactionStatus.PROCESSED, source: 'auto', note: 'Nạp 2.000.000đ', daysOld: 58 },
  { offset: 1, gateway: 'MB', amount: 1000000, status: TransactionStatus.PROCESSED, source: 'auto', note: 'Nạp 1.000.000đ', daysOld: 34 },
  { offset: 2, gateway: 'TCB', amount: 1500000, status: TransactionStatus.PROCESSED, source: 'auto', note: 'Nạp 1.500.000đ', daysOld: 19 },
  { offset: 3, gateway: 'MANUAL', amount: 500000, status: TransactionStatus.PROCESSED, source: 'manual', note: 'Admin nạp tay bù khuyến mãi', daysOld: 11 },
  { offset: 4, gateway: 'BINANCE', amount: 1300000, status: TransactionStatus.PROCESSED, source: 'auto', note: 'Nạp 50 USDT qua TRC20', daysOld: 7, method: PaymentMethod.USDT_TRC20, cryptoAmount: 50, txHash: 'TX9f3b1c7e5a2d8046b9c3e1f7a5d208b64c9e3f10' },
  { offset: 5, gateway: 'VCB', amount: 800000, status: TransactionStatus.PENDING, source: 'auto', note: 'Trùng giao dịch — chờ admin xác nhận', daysOld: 0.1 },
  { offset: 6, gateway: 'ACB', amount: 300000, status: TransactionStatus.FAILED, source: 'auto', note: 'Checksum không hợp lệ', daysOld: 2 },
  { offset: 7, gateway: 'MB', amount: 5000, status: TransactionStatus.REJECTED, source: 'auto', note: 'Dưới mức nạp tối thiểu — admin từ chối', daysOld: 4 },
];

const CHAT: { from: 'user' | 'admin'; text: string }[] = [
  { from: 'user', text: 'Chào shop, đơn ORD-DEMO-M1 của mình đặt 10 IP mà chỉ nhận được 7 ạ?' },
  { from: 'admin', text: 'Chào bạn, đơn này provider chỉ trả về 7 IP nên hệ thống để trạng thái "thiếu số lượng".' },
  { from: 'admin', text: 'Bạn muốn mình cấp bù 3 IP còn lại hay hoàn tiền phần thiếu?' },
  { from: 'user', text: 'Cho mình cấp bù 3 IP nhé, cùng dải Viettel như 7 cái kia.' },
  { from: 'admin', text: 'Mình đã ghi nhận, dải Viettel về hàng trong hôm nay là mình cấp bù ngay cho bạn.' },
  { from: 'user', text: 'Ok cảm ơn shop, mình chờ nhé.' },
  { from: 'user', text: 'Shop ơi cho mình hỏi thêm proxy xoay có giới hạn số luồng không?' },
];

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 24 * 60 * 60 * 1000);

function ipv4(rand: () => number): string {
  return `103.${Math.floor(rand() * 200) + 20}.${Math.floor(rand() * 250)}.${Math.floor(rand() * 250) + 2}`;
}

function ipv6(rand: () => number): string {
  const seg = () => Math.floor(rand() * 65535).toString(16).padStart(4, '0');
  return `2401:${seg()}:${seg()}::${seg()}`;
}

function hex(rand: () => number, len: number): string {
  return Array.from({ length: len }, () =>
    '0123456789ABCDEF'[Math.floor(rand() * 16)],
  ).join('');
}

export async function seedUserDemo(): Promise<SeedResult> {
  const result = emptyResult();
  const rand = rng(20260805);

  const demo: any = await User.findOne({ email: DEMO_EMAIL }).lean().exec();
  if (!demo) {
    throw new Error(
      `Không tìm thấy tài khoản demo ${DEMO_EMAIL}. Chạy "npx ts-node src/seeds/seed-user.ts" trước.`,
    );
  }
  const uid = demo._id as mongoose.Types.ObjectId;

  // ─── 1. Hồ sơ: các field trang profile / deposits / docs-api cần ────────
  const profilePatch: Record<string, any> = {};
  if (!demo.topup_code) profilePatch.topup_code = 'NAPDE100001';
  if (!demo.api_token) profilePatch.api_token = 'fpx_live_9f3b1c7e5a2d8046b9c3e1f7a5d208b6';
  if (!demo.country) profilePatch.country = 'VN';
  if (!demo.bank_account) {
    profilePatch.bank_name = 'Vietcombank';
    profilePatch.bank_account = '0071000998877';
    profilePatch.bank_owner = 'NGUYEN VAN DEMO';
  }
  if (Object.keys(profilePatch).length > 0) {
    await User.updateOne({ _id: uid }, profilePatch).exec();
    result.updated++;
  } else {
    result.skipped++;
  }

  // ─── 2. Downline cho trang affiliate ────────────────────────────────────
  // Lấy user chưa được ai giới thiệu, ưu tiên người đã có đơn để sinh hoa hồng.
  const currentRefs = await User.countDocuments({ referred_by: uid }).exec();
  if (currentRefs < REFERRAL_COUNT) {
    const candidates = await User.find({
      _id: { $ne: uid },
      role: UserRoleEnum.USER,
      referred_by: null,
    })
      .sort({ _id: 1 })
      .select('_id')
      .lean()
      .exec();

    // Chỉ nhận user đã có đơn đã thanh toán → commission mới có gì để tính
    const withOrders: mongoose.Types.ObjectId[] = [];
    for (const c of candidates as any[]) {
      if (withOrders.length >= REFERRAL_COUNT - currentRefs) break;
      const n = await Order.countDocuments({
        user_id: c._id,
        payment_status: PaymentStatusEnum.PAID,
      }).exec();
      if (n > 0) withOrders.push(c._id);
    }

    for (const id of withOrders) {
      await User.updateOne({ _id: id }, { referred_by: uid }).exec();
      result.updated++;
    }
  } else {
    result.skipped++;
  }

  // ─── 3. Đơn hàng phủ đủ trạng thái ──────────────────────────────────────
  const services = await Service.find({}).lean().exec();
  const serviceByName = new Map(services.map((s: any) => [s.name, s]));
  // Model.db thay vì mongoose.connection: namespace import không expose connection
  const countries = Order.db.collection('countries');
  const vnCountry = await countries.findOne({ code: 'VN' });
  const usCountry = await countries.findOne({ code: 'US' });

  for (const plan of ORDERS) {
    const orderCode = `${ORDER_PREFIX}${plan.suffix}`;
    if (await Order.findOne({ order_code: orderCode }).select('_id').lean().exec()) {
      result.skipped++;
      continue;
    }

    const svc: any = serviceByName.get(plan.serviceName);
    if (!svc) continue;

    const pricePerUnit: number =
      svc.pricing?.[String(plan.duration)] != null
        ? svc.pricing[String(plan.duration)] / plan.duration
        : 1000;
    const totalPrice = Math.round(pricePerUnit * plan.quantity * plan.duration);
    const costPerUnit = Math.round(pricePerUnit * 0.68);
    const totalCost = Math.round(costPerUnit * plan.quantity * plan.duration);

    const createdAt = daysAgo(plan.daysOld);
    const isPaid =
      plan.status !== OrderStatusEnum.PENDING && plan.status !== OrderStatusEnum.CANCELLED;
    const isLive = plan.status === OrderStatusEnum.ACTIVE;
    const actualQty = plan.actualQuantity ?? plan.quantity;
    const isForeign = plan.serviceName.includes('Ngoại');

    const order = await Order.create({
      order_code: orderCode,
      user_id: uid,
      service_id: svc._id,
      partner_id: svc.partner ?? null,
      country_id: (isForeign ? usCountry?._id : vnCountry?._id) ?? null,
      proxy_type: svc.proxy_type,
      order_type: svc.type,
      quantity: plan.quantity,
      duration_days: plan.duration,
      bandwidth_gb: plan.bandwidthGb ?? null,
      bandwidth_used_gb: plan.bandwidthGb ? Math.round(plan.bandwidthGb * 0.4) : 0,
      price_per_unit: pricePerUnit,
      cost_per_unit: costPerUnit,
      total_price: totalPrice,
      total_cost: totalCost,
      profit: totalPrice - totalCost,
      status: plan.status,
      payment_status: isPaid ? PaymentStatusEnum.PAID : PaymentStatusEnum.UNPAID,
      payment_method: isPaid ? PaymentMethodEnum.BALANCE : null,
      start_date: isPaid ? createdAt : null,
      end_date: isPaid ? addDays(createdAt, plan.duration) : null,
      config:
        svc.type === 'rotating'
          ? { rotation_time: 10, gateway_host: 'gate.fastproxyvn.com', protocol: 'socks5' }
          : { protocol: 'http', isp: isForeign ? 'AT&T' : 'VIETTEL' },
      credentials:
        svc.type === 'rotating'
          ? {
              host: 'gate.fastproxyvn.com',
              port: 9000 + ORDERS.indexOf(plan),
              username: `demo${hex(rand, 4)}`,
              password: hex(rand, 8),
            }
          : null,
      provider_order_id: isPaid ? `PROV-${orderCode}` : '',
      auto_renew: plan.autoRenew ?? false,
      actual_quantity: actualQty === plan.quantity ? null : actualQty,
      refunded_amount: plan.refunded ?? 0,
      error_message: plan.errorMessage ?? '',
    });
    await forceTimestamps(Order, { _id: order._id }, createdAt);
    result.created++;

    // ─── Proxy tĩnh kèm theo đơn ─────────────────────────────────────────
    if (svc.type === 'static' && isPaid && plan.status !== OrderStatusEnum.FAILED) {
      for (let i = 0; i < actualQty; i++) {
        const isV6 = svc.ip_version === 'v6';
        const p = await Proxy.create({
          order_id: order._id,
          proxy_type_id: svc._id,
          ip_address: isV6 ? ipv6(rand) : ipv4(rand),
          port: 20000 + Math.floor(rand() * 40000),
          protocol: ProxyProtocolEnum.HTTP,
          auth_username: hex(rand, 6),
          auth_password: hex(rand, 8),
          country_code: isForeign ? 'US' : 'VN',
          location: isForeign ? 'United States' : 'Việt Nam',
          isp: isForeign ? 'AT&T' : 'Viettel',
          provider: 'twoproxy',
          provider_proxy_id: String(700000 + Math.floor(rand() * 99999)),
          is_active: isLive,
          is_available: isLive,
          health_status: isLive ? HealthStatusEnum.HEALTHY : HealthStatusEnum.DEAD,
          last_checked_at: createdAt,
        });
        await forceTimestamps(Proxy, { _id: p._id }, createdAt);
      }
    }

    // ─── Nhật ký xử lý đơn (trang chi tiết đơn của user) ─────────────────
    const logs: { step: OrderLogStep; level: OrderLogLevel; message: string; offsetMs: number }[] = [
      { step: OrderLogStep.BUY_INITIATED, level: OrderLogLevel.INFO, message: `User đặt ${plan.quantity} proxy × ${plan.duration} ngày`, offsetMs: 0 },
      { step: OrderLogStep.BUY_PRICING_RESOLVED, level: OrderLogLevel.INFO, message: `Đơn giá ${pricePerUnit}đ/proxy/ngày — tổng ${totalPrice.toLocaleString('vi-VN')}đ`, offsetMs: 400 },
    ];

    if (plan.status === OrderStatusEnum.PENDING) {
      logs.push({ step: OrderLogStep.BUY_QUEUED, level: OrderLogLevel.INFO, message: 'Đơn đã vào hàng đợi, chờ trừ số dư', offsetMs: 900 });
    } else if (plan.status === OrderStatusEnum.CANCELLED) {
      logs.push({ step: OrderLogStep.ADMIN_STATUS_UPDATED, level: OrderLogLevel.WARN, message: 'User huỷ đơn trước khi cấp phát', offsetMs: 5000 });
    } else {
      logs.push(
        { step: OrderLogStep.BUY_BALANCE_DEDUCTED, level: OrderLogLevel.INFO, message: `Trừ ${totalPrice.toLocaleString('vi-VN')}đ từ số dư`, offsetMs: 800 },
        { step: OrderLogStep.WORKER_PROVIDER_CALL, level: OrderLogLevel.INFO, message: `Gọi provider ${svc.partner ? 'twoproxy' : 'nội bộ'}`, offsetMs: 2500 },
      );

      if (plan.status === OrderStatusEnum.FAILED) {
        logs.push({ step: OrderLogStep.WORKER_PROVIDER_FAIL, level: OrderLogLevel.ERROR, message: plan.errorMessage ?? 'Provider trả về lỗi', offsetMs: 6000 });
      } else if (plan.status === OrderStatusEnum.PROCESSING) {
        logs.push({ step: OrderLogStep.WORKER_STATUS_PROCESSING, level: OrderLogLevel.INFO, message: 'Provider nhận đơn, đang cấp phát — hệ thống sẽ tự kiểm tra lại', offsetMs: 5200 });
      } else if (plan.status === OrderStatusEnum.PARTIAL) {
        logs.push(
          { step: OrderLogStep.WORKER_PROXIES_INSERTED, level: OrderLogLevel.INFO, message: `Nhận ${actualQty}/${plan.quantity} proxy`, offsetMs: 5400 },
          { step: OrderLogStep.WORKER_STATUS_PARTIAL, level: OrderLogLevel.WARN, message: `Thiếu ${plan.quantity - actualQty} proxy — chờ admin xử lý`, offsetMs: 5600 },
        );
      } else {
        logs.push(
          { step: OrderLogStep.WORKER_PROXIES_INSERTED, level: OrderLogLevel.INFO, message: `Đã ghi ${actualQty} proxy vào đơn`, offsetMs: 5400 },
          { step: OrderLogStep.WORKER_STATUS_ACTIVE, level: OrderLogLevel.INFO, message: 'Đơn chuyển sang ACTIVE — proxy sẵn sàng sử dụng', offsetMs: 5600 },
        );
      }

      if (plan.status === OrderStatusEnum.EXPIRED) {
        logs.push({ step: OrderLogStep.EXPIRED, level: OrderLogLevel.INFO, message: 'Order hết hạn — proxy đã bị vô hiệu hóa', offsetMs: plan.duration * 86400000 });
      }
      if (plan.refunded) {
        logs.push({ step: OrderLogStep.ADMIN_REFUND_APPROVED, level: OrderLogLevel.INFO, message: `Admin hoàn ${plan.refunded.toLocaleString('vi-VN')}đ phần proxy thiếu`, offsetMs: 86400000 });
      }
      if (plan.autoRenew) {
        logs.push({ step: OrderLogStep.AUTO_ORDER_RENEWED, level: OrderLogLevel.INFO, message: 'Bật tự động gia hạn — sẽ gia hạn trước hạn 5 ngày', offsetMs: 7000 });
      }
    }

    for (const l of logs) {
      const created = await OrderLog.create({
        order_id: order._id,
        step: l.step,
        level: l.level,
        message: l.message,
        data: { order_code: orderCode },
        actor: l.step.startsWith('buy.') ? String(uid) : 'system',
      });
      await forceTimestamps(OrderLog, { _id: created._id }, new Date(createdAt.getTime() + l.offsetMs));
    }
  }

  // ─── 4. Lịch sử nạp tiền ────────────────────────────────────────────────
  const topupCode = profilePatch.topup_code ?? demo.topup_code ?? 'NAPDE100001';
  let runningBalance = 0;

  for (const d of DEPOSITS) {
    const txId = TX_ID_BASE + d.offset;
    if (await Transaction.findOne({ transaction_id: txId }).select('_id').lean().exec()) {
      result.skipped++;
      continue;
    }

    const at = daysAgo(d.daysOld);
    const processed = d.status === TransactionStatus.PROCESSED;
    const before = runningBalance;
    if (processed) runningBalance += d.amount;

    const created = await Transaction.create({
      transaction_id: txId,
      gateway: d.gateway,
      transaction_date: at,
      transaction_number: d.source === 'manual' ? '' : `FT${txId}`,
      account_number: d.source === 'manual' ? '' : '0071000512345',
      content: d.source === 'manual' ? d.note : `${topupCode} nap tien proxy`,
      code: d.source === 'manual' ? '' : topupCode,
      transfer_type: 'IN',
      transfer_amount: d.amount,
      checksum: d.status === TransactionStatus.FAILED ? 'invalid_checksum' : `chk${txId}`,
      status: d.status,
      user_id: uid,
      balance_before: processed ? before : 0,
      balance_after: processed ? runningBalance : 0,
      source: d.source,
      payment_method: d.method ?? PaymentMethod.BANK,
      crypto_amount: d.cryptoAmount ?? 0,
      tx_hash: d.txHash ?? '',
      note: d.note,
    });
    await forceTimestamps(Transaction, { _id: created._id }, at);
    result.created++;
  }

  // ─── 5. Hội thoại hỗ trợ ────────────────────────────────────────────────
  const roomId = String(uid);
  const chatStart = daysAgo(0.6);
  for (let i = 0; i < CHAT.length; i++) {
    const turn = CHAT[i];
    if (
      await ChatMessage.findOne({ room_id: roomId, sender_type: turn.from, content: turn.text })
        .select('_id')
        .lean()
        .exec()
    ) {
      result.skipped++;
      continue;
    }
    const created = await ChatMessage.create({
      room_id: roomId,
      sender_type: turn.from,
      content: turn.text,
      type: 'text',
      recalled: false,
      // Tin cuối của user để chưa đọc → admin thấy badge
      read: turn.from === 'admin' ? true : i < CHAT.length - 1,
    });
    await forceTimestamps(ChatMessage, { _id: created._id }, new Date(chatStart.getTime() + i * 4 * 60 * 1000));
    result.created++;
  }

  return result;
}
