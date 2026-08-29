import * as mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import { UserSchema } from '../../schemas/users.schema';
import { OrderSchema } from '../../schemas/orders.schema';
import { ProxySchema } from '../../schemas/proxies.schema';
import { ServiceSchema } from '../../schemas/services.schema';
import {
  OrderStatusEnum,
  PaymentMethodEnum,
  PaymentStatusEnum,
} from '../../enum/order.enum';
import { UserRoleEnum, UserStatusEnum } from '../../enum/user.enum';
import { HealthStatusEnum, ProxyProtocolEnum } from '../../enum/proxy.enum';
import { daysAgo, emptyResult, forceTimestamps, rng, SeedResult } from '../lib/db';
import { DEMO_EMAIL } from './user-demo.seed';

const User = mongoose.models.UserSeedRef || mongoose.model('UserSeedRef', UserSchema, 'users');
const Order = mongoose.models.OrderSeedRef || mongoose.model('OrderSeedRef', OrderSchema, 'orders');
const Proxy = mongoose.models.ProxySeedRef || mongoose.model('ProxySeedRef', ProxySchema, 'proxies');
const Service =
  mongoose.models.ServiceSeedRef || mongoose.model('ServiceSeedRef', ServiceSchema, 'services');

/**
 * Tuyến dưới cho tài khoản demo.
 *
 * `affiliate.seed` chỉ tính hoa hồng từ đơn ĐÃ THANH TOÁN của người được giới
 * thiệu — không có tuyến dưới thì trang affiliate trắng. Bước tuyển người từ
 * user có sẵn trong `user-demo.seed` chỉ chạy được trên DB đã có sẵn user thật
 * kèm đơn, nên ở đây tạo hẳn tuyến dưới riêng để DB nào cũng có dữ liệu.
 */

const PASSWORD = 'User@12345';

interface RefUser {
  slug: string;
  name: string;
  /** Số ngày kể từ lúc đăng ký */
  joinedDaysAgo: number;
  /** Mỗi phần tử là một đơn: [số lượng, số ngày, số ngày tuổi của đơn, trạng thái] */
  orders: [number, number, number, OrderStatusEnum][];
}

const REFERRALS: RefUser[] = [
  {
    slug: 'ref1',
    name: 'Trần Minh Quân',
    joinedDaysAgo: 68,
    orders: [
      [10, 30, 60, OrderStatusEnum.ACTIVE],
      [5, 30, 25, OrderStatusEnum.ACTIVE],
    ],
  },
  {
    slug: 'ref2',
    name: 'Phạm Thu Hà',
    joinedDaysAgo: 52,
    orders: [[20, 30, 45, OrderStatusEnum.EXPIRED]],
  },
  {
    slug: 'ref3',
    name: 'Lê Hoàng Nam',
    joinedDaysAgo: 40,
    orders: [
      [3, 7, 35, OrderStatusEnum.COMPLETED],
      [8, 30, 14, OrderStatusEnum.ACTIVE],
    ],
  },
  {
    slug: 'ref4',
    name: 'Vũ Thị Ngọc',
    joinedDaysAgo: 27,
    orders: [[15, 30, 20, OrderStatusEnum.ACTIVE]],
  },
  {
    slug: 'ref5',
    name: 'Đỗ Anh Tuấn',
    joinedDaysAgo: 9,
    // Mới đăng ký, chưa mua gì — tuyến dưới thật luôn có người như vậy
    orders: [],
  },
];

/** Dịch vụ dùng cho đơn của tuyến dưới, ưu tiên tên của bộ seed mới. */
const SERVICE_NAMES = [
  'Proxy IPv4 Private Viettel',
  'Proxy IPv4 Share Viettel',
  'Proxy IPV4 Private',
];

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 24 * 60 * 60 * 1000);

const ipv4 = (rand: () => number) =>
  `171.${Math.floor(rand() * 200) + 20}.${Math.floor(rand() * 250)}.${Math.floor(rand() * 250) + 2}`;

const hex = (rand: () => number, len: number) =>
  Array.from({ length: len }, () => '0123456789ABCDEF'[Math.floor(rand() * 16)]).join('');

export async function seedDownline(): Promise<SeedResult> {
  const result = emptyResult();
  const rand = rng(20260807);

  const referrer: any = await User.findOne({ email: DEMO_EMAIL }).select('_id').lean().exec();
  if (!referrer) {
    throw new Error(`Không tìm thấy tài khoản demo ${DEMO_EMAIL} để gán tuyến dưới.`);
  }

  let svc: any = null;
  for (const name of SERVICE_NAMES) {
    svc = await Service.findOne({ name }).lean().exec();
    if (svc) break;
  }
  if (!svc) {
    // Không có dịch vụ nào khớp thì lấy đại một gói tĩnh đang bán
    svc = await Service.findOne({ type: 'static', status: true }).lean().exec();
  }
  if (!svc) return result;

  const hash = await bcrypt.hash(PASSWORD, 10);
  const countries = Order.db.collection('countries');
  const vnCountry = await countries.findOne({ code: 'VN' });

  for (let i = 0; i < REFERRALS.length; i++) {
    const r = REFERRALS[i];
    const email = `${r.slug}@fastproxyvn.com`;
    const joinedAt = daysAgo(r.joinedDaysAgo);

    let user: any = await User.findOne({ email }).select('_id').lean().exec();
    if (user) {
      result.skipped++;
    } else {
      const created = await User.create({
        name: r.name,
        email,
        password: hash,
        role: UserRoleEnum.USER,
        status: UserStatusEnum.ACTIVE,
        money: 0,
        country: 'VN',
        topup_code: `NAPRF${String(100001 + i)}`,
        referral_code: `FPX${r.slug.toUpperCase()}`,
        referred_by: referrer._id,
        email_verified_at: joinedAt,
        last_login_at: daysAgo(Math.max(0.2, r.joinedDaysAgo / 8)),
      });
      await forceTimestamps(User, { _id: created._id }, joinedAt);
      user = { _id: created._id };
      result.created++;
    }

    // Người đã tồn tại nhưng chưa gắn tuyến — gắn lại để hoa hồng tính được
    await User.updateOne(
      { _id: user._id, referred_by: null },
      { referred_by: referrer._id },
    ).exec();

    // ─── Đơn hàng của tuyến dưới ──────────────────────────────────────────
    for (let j = 0; j < r.orders.length; j++) {
      const [quantity, duration, daysOld, status] = r.orders[j];
      const orderCode = `ORD-REF-${r.slug.toUpperCase()}-${j + 1}`;

      if (await Order.findOne({ order_code: orderCode }).select('_id').lean().exec()) {
        result.skipped++;
        continue;
      }

      const tier = svc.pricing?.[String(duration)];
      const pricePerUnit = Number(tier?.price) || duration * 1200;
      const costPerUnit = Number(tier?.cost) || Math.round(pricePerUnit * 0.68);
      const totalPrice = pricePerUnit * quantity;
      const totalCost = costPerUnit * quantity;
      const createdAt = daysAgo(daysOld);
      const isLive = status === OrderStatusEnum.ACTIVE;

      const order = await Order.create({
        order_code: orderCode,
        user_id: user._id,
        service_id: svc._id,
        partner_id: svc.partner ?? null,
        country_id: vnCountry?._id ?? null,
        proxy_type: svc.proxy_type,
        order_type: svc.type,
        pricing_mode: 'duration',
        quantity,
        duration_days: duration,
        bandwidth_gb: null,
        price_per_unit: pricePerUnit,
        cost_per_unit: costPerUnit,
        total_price: totalPrice,
        total_cost: totalCost,
        profit: totalPrice - totalCost,
        status,
        payment_status: PaymentStatusEnum.PAID,
        payment_method: PaymentMethodEnum.BALANCE,
        start_date: createdAt,
        end_date: addDays(createdAt, duration),
        config: { protocol: 'http', isp: 'VIETTEL' },
        provider_order_id: `PROV-${orderCode}`,
        auto_renew: false,
        refunded_amount: 0,
        error_message: '',
      });
      await forceTimestamps(Order, { _id: order._id }, createdAt);
      result.created++;

      // Chỉ đơn còn sống mới cần proxy — đơn hết hạn giữ lịch sử là đủ
      if (isLive) {
        for (let k = 0; k < quantity; k++) {
          const p = await Proxy.create({
            order_id: order._id,
            proxy_type_id: svc._id,
            ip_address: ipv4(rand),
            port: 20000 + Math.floor(rand() * 40000),
            protocol: ProxyProtocolEnum.HTTP,
            auth_username: hex(rand, 6),
            auth_password: hex(rand, 8),
            country_code: 'VN',
            location: 'Việt Nam',
            isp: 'Viettel',
            provider: 'twoproxy',
            provider_proxy_id: String(800000 + Math.floor(rand() * 99999)),
            is_active: true,
            is_available: true,
            health_status: HealthStatusEnum.HEALTHY,
            last_checked_at: createdAt,
          });
          await forceTimestamps(Proxy, { _id: p._id }, createdAt);
        }
      }
    }
  }

  return result;
}
