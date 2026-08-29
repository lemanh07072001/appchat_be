import * as mongoose from 'mongoose';
import { ServiceSchema } from '../../schemas/services.schema';
import { emptyResult, SeedResult } from '../lib/db';

const Service =
  mongoose.models.ServiceSeedCat ||
  mongoose.model('ServiceSeedCat', ServiceSchema, 'services');

/**
 * `findPublicList()` (services.service.ts) CHỈ lọc theo category(type) / usage_type /
 * ip_version. Mỗi trang sản phẩm ứng với đúng một bộ 3 giá trị dưới đây — sai
 * `usage_type` là dịch vụ rơi nhầm trang.
 *
 *   /proxy-ipv4-private    static  + private   + v4
 *   /proxy-ipv4-share      static  + share     + v4
 *   /proxy-ipv4-foreign    static  + foreign   + v4
 *   /proxy-ipv4-xoay                 xoay      + v4
 *   /proxy-ipv4-xoay-key   rotating+ key_xoay  + v4
 *   (bộ tương ứng cho v6)
 */

const ISP_VN = [
  { name: 'Viettel', code: 'viettel' },
  { name: 'VNPT', code: 'vnpt' },
  { name: 'FPT', code: 'fpt' },
  { name: 'Mobifone', code: 'mobifone' },
];
const ISP_US = [
  { name: 'Comcast', code: 'comcast' },
  { name: 'AT&T', code: 'att' },
  { name: 'Verizon', code: 'verizon' },
];

/** Bậc giá theo thời hạn: giá/ngày giảm dần khi mua dài hạn. */
function tiers(dayPrice: number, margin = 0.32): Record<string, { price: number; cost: number }> {
  const plan: [string, number][] = [
    ['1', 1],
    ['7', 0.93],
    ['30', 0.82],
    ['60', 0.76],
    ['90', 0.7],
  ];
  const out: Record<string, { price: number; cost: number }> = {};
  for (const [days, factor] of plan) {
    const price = Math.round((dayPrice * Number(days) * factor) / 100) * 100;
    out[days] = { price, cost: Math.round((price * (1 - margin)) / 100) * 100 };
  }
  return out;
}

/** Hệ số giảm giá theo dung lượng — dùng chung cho gói cố định và bậc giá. */
const gbFactor = (gb: number): number => (gb >= 50 ? 0.78 : gb >= 25 ? 0.85 : gb >= 10 ? 0.92 : 1);

/**
 * Gói dung lượng cố định cho `pricing_mode: 'bandwidth'`.
 * Value phải có `gb` và `days` — `resolvePricing()` đọc hai field này khi khách
 * chọn gói sẵn (`package_key`), thiếu là đơn bị từ chối.
 */
function gbTiers(
  gbPrice: number,
  margin = 0.3,
): Record<string, { gb: number; days: number; price: number; cost: number }> {
  const out: Record<string, { gb: number; days: number; price: number; cost: number }> = {};
  for (const gb of [2, 5, 10, 25, 50, 100]) {
    const price = Math.round((gbPrice * gb * gbFactor(gb)) / 1000) * 1000;
    out[String(gb)] = {
      gb,
      days: 30,
      price,
      cost: Math.round((price * (1 - margin)) / 1000) * 1000,
    };
  }
  return out;
}

/**
 * Bậc giá cho khách tự nhập số GB (`bandwidth_tiers`). Giá phẳng theo bậc đang
 * đứng — cùng thang giảm với gói cố định ở trên để hai lối mua không lệch giá.
 */
function gbBands(
  gbPrice: number,
  margin = 0.3,
): { min_gb: number; price_per_gb: number; cost_per_gb: number; days: number }[] {
  return [1, 10, 25, 50].map((minGb) => {
    const pricePerGb = Math.round((gbPrice * gbFactor(minGb)) / 100) * 100;
    return {
      min_gb: minGb,
      price_per_gb: pricePerGb,
      cost_per_gb: Math.round((pricePerGb * (1 - margin)) / 100) * 100,
      days: 30,
    };
  });
}

interface Seed {
  name: string;
  type: 'static' | 'rotating';
  usage_type: 'private' | 'share' | 'foreign' | 'xoay' | 'key_xoay';
  ip_version: 'v4' | 'v6';
  proxy_type: string;
  partnerCode: string;
  countryCode?: string;
  isp: { name: string; code: string }[];
  protocol: string[];
  /** Bán theo thời hạn — bảng giá khoá theo số ngày. */
  pricing?: Record<string, { price: number; cost: number }>;
  /**
   * Bán theo dung lượng — giá gốc mỗi GB. Khai field này thay cho `pricing`:
   * gói cố định (`pricing`) và bậc giá tự nhập (`bandwidth_tiers`) đều sinh ra
   * từ cùng một con số nên hai lối mua không bao giờ lệch giá.
   */
  bandwidthPrice?: number;
  min_quantity: number;
  max_quantity: number;
  badge?: string;
  order: number;
  note: Record<string, string>;
  api_enabled?: boolean;
  show_user_pass?: boolean;
  status?: boolean;
}

const SERVICES: Seed[] = [
  // ─── IPv4 tĩnh riêng tư ────────────────────────────────────────────────
  {
    name: 'Proxy IPv4 Private Viettel', type: 'static', usage_type: 'private', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'twoproxy', countryCode: 'VN',
    isp: [ISP_VN[0]], protocol: ['http', 'socks5'], pricing: tiers(1200),
    min_quantity: 1, max_quantity: 200, badge: 'HOT', order: 1, api_enabled: true,
    note: { vi: 'IP tĩnh nhà mạng Viettel, cấp riêng cho một tài khoản. Tốc độ ổn định, hợp nuôi tài khoản dài hạn.' },
  },
  {
    name: 'Proxy IPv4 Private VNPT', type: 'static', usage_type: 'private', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'twoproxy', countryCode: 'VN',
    isp: [ISP_VN[1]], protocol: ['http', 'socks5'], pricing: tiers(1100),
    min_quantity: 1, max_quantity: 200, order: 2, api_enabled: true,
    note: { vi: 'IP tĩnh VNPT, độ trễ thấp trong nước, phù hợp truy cập dịch vụ nội địa.' },
  },
  {
    name: 'Proxy IPv4 Private FPT', type: 'static', usage_type: 'private', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'proxyvn', countryCode: 'VN',
    isp: [ISP_VN[2]], protocol: ['http', 'socks5'], pricing: tiers(1000),
    min_quantity: 1, max_quantity: 150, order: 3,
    note: { vi: 'IP tĩnh FPT giá tốt, thích hợp chạy số lượng vừa.' },
  },
  {
    name: 'Proxy IPv4 Private Dân Cư', type: 'static', usage_type: 'private', ip_version: 'v4',
    proxy_type: 'residential', partnerCode: 'homeproxy', countryCode: 'VN',
    isp: ISP_VN.slice(0, 3), protocol: ['http', 'socks5'], pricing: tiers(2500),
    min_quantity: 1, max_quantity: 50, badge: 'PREMIUM', order: 4,
    note: { vi: 'IP dân cư thật từ hộ gia đình — tỉ lệ bị phát hiện thấp nhất, dành cho tác vụ khó.' },
  },

  // ─── IPv4 tĩnh dùng chung ──────────────────────────────────────────────
  {
    name: 'Proxy IPv4 Share Viettel', type: 'static', usage_type: 'share', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'twoproxy', countryCode: 'VN',
    isp: [ISP_VN[0]], protocol: ['http'], pricing: tiers(500),
    min_quantity: 1, max_quantity: 300, badge: 'GIÁ RẺ', order: 10,
    note: { vi: 'IP dùng chung tối đa 3 người, giá chỉ bằng một nửa gói riêng. Hợp việc nhẹ, không nuôi tài khoản.' },
  },
  {
    name: 'Proxy IPv4 Share VNPT', type: 'static', usage_type: 'share', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'twoproxy', countryCode: 'VN',
    isp: [ISP_VN[1]], protocol: ['http'], pricing: tiers(450),
    min_quantity: 1, max_quantity: 300, order: 11,
    note: { vi: 'IP VNPT dùng chung, phù hợp duyệt web và kiểm tra nội dung theo vùng.' },
  },
  {
    name: 'Proxy IPv4 Share Tiết Kiệm', type: 'static', usage_type: 'share', ip_version: 'v4',
    proxy_type: 'datacenter', partnerCode: 'proxyvn', countryCode: 'VN',
    isp: ISP_VN.slice(0, 4), protocol: ['http'], pricing: tiers(300),
    min_quantity: 5, max_quantity: 500, order: 12,
    note: { vi: 'Gói rẻ nhất, IP datacenter dùng chung. Mua tối thiểu 5 IP.' },
  },

  // ─── IPv4 tĩnh nước ngoài ──────────────────────────────────────────────
  {
    name: 'Proxy IPv4 Mỹ (US)', type: 'static', usage_type: 'foreign', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'proxyvn', countryCode: 'US',
    isp: ISP_US, protocol: ['http', 'socks5'], pricing: tiers(2200),
    min_quantity: 1, max_quantity: 100, badge: 'HOT', order: 20, api_enabled: true,
    note: { vi: 'IP đặt tại Hoa Kỳ, phù hợp chạy quảng cáo và truy cập dịch vụ giới hạn theo vùng.' },
  },
  {
    name: 'Proxy IPv4 Singapore', type: 'static', usage_type: 'foreign', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'proxyvn', countryCode: 'SG',
    isp: [], protocol: ['http', 'socks5'], pricing: tiers(1800),
    min_quantity: 1, max_quantity: 100, order: 21,
    note: { vi: 'IP Singapore — độ trễ thấp nhất trong nhóm quốc tế khi truy cập từ Việt Nam.' },
  },
  {
    name: 'Proxy IPv4 Nhật Bản', type: 'static', usage_type: 'foreign', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'twoproxy', countryCode: 'JP',
    isp: [], protocol: ['http', 'socks5'], pricing: tiers(2000),
    min_quantity: 1, max_quantity: 80, order: 22,
    note: { vi: 'IP Nhật Bản, hợp các dịch vụ nội dung và thương mại điện tử khu vực Đông Á.' },
  },
  {
    name: 'Proxy IPv4 Đức (DE)', type: 'static', usage_type: 'foreign', ip_version: 'v4',
    proxy_type: 'datacenter', partnerCode: 'twoproxy', countryCode: 'DE',
    isp: [], protocol: ['http', 'socks5'], pricing: tiers(1700),
    min_quantity: 1, max_quantity: 80, order: 23,
    note: { vi: 'IP châu Âu đặt tại Đức, băng thông cao, phù hợp thu thập dữ liệu quốc tế.' },
  },

  // ─── IPv4 xoay theo thời gian ──────────────────────────────────────────
  {
    name: 'Proxy IPv4 Xoay Dân Cư', type: 'rotating', usage_type: 'xoay', ip_version: 'v4',
    proxy_type: 'residential', partnerCode: 'homeproxy', countryCode: 'VN',
    isp: ISP_VN.slice(0, 3), protocol: ['http', 'socks5'], bandwidthPrice: 22000,
    min_quantity: 1, max_quantity: 1, badge: 'HOT', order: 30, api_enabled: true,
    note: { vi: 'Kho IP dân cư xoay theo mỗi request. Tính tiền theo GB, hợp thu thập dữ liệu quy mô lớn.' },
  },
  {
    name: 'Proxy IPv4 Xoay Datacenter', type: 'rotating', usage_type: 'xoay', ip_version: 'v4',
    proxy_type: 'datacenter', partnerCode: 'proxyvn', countryCode: 'VN',
    isp: ISP_VN.slice(0, 2), protocol: ['http'], bandwidthPrice: 9000,
    min_quantity: 1, max_quantity: 1, order: 31,
    note: { vi: 'Xoay IP mỗi 5–10 phút, băng thông cao, giá rẻ hơn gói dân cư nhiều lần.' },
  },
  {
    name: 'Proxy IPv4 Xoay Toàn Cầu', type: 'rotating', usage_type: 'xoay', ip_version: 'v4',
    proxy_type: 'residential', partnerCode: 'homeproxy', countryCode: 'US',
    isp: ISP_US, protocol: ['http', 'socks5'], bandwidthPrice: 28000,
    min_quantity: 1, max_quantity: 1, badge: 'PREMIUM', order: 32,
    note: { vi: 'Chọn quốc gia đầu ra trong hơn 40 nước, xoay theo request.' },
  },

  // ─── IPv4 xoay theo key ────────────────────────────────────────────────
  {
    name: 'Proxy IPv4 Key Xoay 1 Giờ', type: 'rotating', usage_type: 'key_xoay', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'homeproxy', countryCode: 'VN',
    isp: ISP_VN.slice(0, 3), protocol: ['http', 'socks5'], pricing: tiers(1500),
    min_quantity: 1, max_quantity: 100, order: 40, show_user_pass: false,
    note: { vi: 'Mỗi key một IP, tự đổi IP sau 1 giờ hoặc bấm đổi thủ công qua đường dẫn xoay.' },
  },
  {
    name: 'Proxy IPv4 Key Xoay Không Giới Hạn', type: 'rotating', usage_type: 'key_xoay', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'homeproxy', countryCode: 'VN',
    isp: ISP_VN.slice(0, 4), protocol: ['http', 'socks5'], pricing: tiers(2400),
    min_quantity: 1, max_quantity: 50, badge: 'HOT', order: 41, show_user_pass: false, api_enabled: true,
    note: { vi: 'Đổi IP không giới hạn số lần, mỗi lần cách nhau 60 giây. Dành cho tác vụ cần IP mới liên tục.' },
  },
  {
    name: 'Proxy IPv4 Key Xoay Theo Tỉnh', type: 'rotating', usage_type: 'key_xoay', ip_version: 'v4',
    proxy_type: 'residential', partnerCode: 'homeproxy', countryCode: 'VN',
    isp: ISP_VN.slice(0, 3), protocol: ['http'], pricing: tiers(2800),
    min_quantity: 1, max_quantity: 30, order: 42, show_user_pass: false,
    note: { vi: 'Chỉ định tỉnh/thành khi xoay — hợp kiểm thử quảng cáo theo địa phương.' },
  },

  // ─── IPv6 ──────────────────────────────────────────────────────────────
  {
    name: 'Proxy IPv6 Private Viettel', type: 'static', usage_type: 'private', ip_version: 'v6',
    proxy_type: 'static_ipv6', partnerCode: 'proxyv6', countryCode: 'VN',
    isp: [ISP_VN[0]], protocol: ['http', 'socks5'], pricing: tiers(700),
    min_quantity: 1, max_quantity: 500, badge: 'GIÁ RẺ', order: 50, api_enabled: true,
    note: { vi: 'IPv6 riêng, giá chỉ bằng một phần nhỏ IPv4. Kiểm tra đích đến có hỗ trợ IPv6 trước khi mua.' },
  },
  {
    name: 'Proxy IPv6 Private VNPT', type: 'static', usage_type: 'private', ip_version: 'v6',
    proxy_type: 'static_ipv6', partnerCode: 'proxyv6', countryCode: 'VN',
    isp: [ISP_VN[1]], protocol: ['http', 'socks5'], pricing: tiers(650),
    min_quantity: 1, max_quantity: 500, order: 51,
    note: { vi: 'IPv6 nhà mạng VNPT, mua số lượng lớn với chi phí thấp.' },
  },
  {
    name: 'Proxy IPv6 Share Số Lượng Lớn', type: 'static', usage_type: 'share', ip_version: 'v6',
    proxy_type: 'datacenter', partnerCode: 'proxyv6', countryCode: 'VN',
    isp: ISP_VN.slice(0, 3), protocol: ['http'], pricing: tiers(250),
    min_quantity: 10, max_quantity: 1000, order: 52,
    note: { vi: 'IPv6 dùng chung, tối thiểu 10 IP. Rẻ nhất trong toàn bộ bảng giá.' },
  },
  {
    name: 'Proxy IPv6 Mỹ (US)', type: 'static', usage_type: 'foreign', ip_version: 'v6',
    proxy_type: 'static_ipv6', partnerCode: 'proxyv6', countryCode: 'US',
    isp: ISP_US, protocol: ['http', 'socks5'], pricing: tiers(900),
    min_quantity: 1, max_quantity: 300, order: 53,
    note: { vi: 'IPv6 đặt tại Hoa Kỳ, chi phí thấp cho tác vụ cần nhiều IP quốc tế.' },
  },
  {
    name: 'Proxy IPv6 Xoay Băng Thông', type: 'rotating', usage_type: 'xoay', ip_version: 'v6',
    proxy_type: 'rotating_ipv6', partnerCode: 'proxyv6', countryCode: 'VN',
    isp: ISP_VN.slice(0, 2), protocol: ['http', 'socks5'], bandwidthPrice: 6000,
    min_quantity: 1, max_quantity: 1, order: 54,
    note: { vi: 'Kho IPv6 xoay theo request, tính theo GB — lựa chọn rẻ nhất cho thu thập dữ liệu.' },
  },
  {
    name: 'Proxy IPv6 Key Xoay', type: 'rotating', usage_type: 'key_xoay', ip_version: 'v6',
    proxy_type: 'rotating_ipv6', partnerCode: 'proxyv6', countryCode: 'VN',
    isp: ISP_VN.slice(0, 3), protocol: ['http', 'socks5'], pricing: tiers(800),
    min_quantity: 1, max_quantity: 200, order: 55, show_user_pass: false,
    note: { vi: 'Key xoay IPv6, đổi IP qua đường dẫn xoay. Giá rẻ, hợp chạy số lượng lớn.' },
  },
  {
    name: 'Proxy IPv6 Xoay Key Cao Cấp', type: 'rotating', usage_type: 'key_xoay', ip_version: 'v6',
    proxy_type: 'rotating_ipv6', partnerCode: 'proxyv6', countryCode: 'SG',
    isp: [], protocol: ['http', 'socks5'], pricing: tiers(1400),
    min_quantity: 1, max_quantity: 100, badge: 'MỚI', order: 56, show_user_pass: false,
    note: { vi: 'Key xoay IPv6 đầu ra Singapore, băng thông cam kết cao hơn gói tiêu chuẩn.' },
  },

  // Một gói tạm ngưng bán để trang admin có dòng status=false
  {
    name: 'Proxy IPv4 Private Mobifone (tạm ngưng)', type: 'static', usage_type: 'private', ip_version: 'v4',
    proxy_type: 'static_ipv4', partnerCode: 'twoproxy', countryCode: 'VN',
    isp: [ISP_VN[3]], protocol: ['http'], pricing: tiers(1300),
    min_quantity: 1, max_quantity: 100, order: 60, status: false,
    note: { vi: 'Tạm ngưng bán do nhà mạng hết dải IP khả dụng.' },
  },
];

/**
 * 5 dịch vụ cũ lưu pricing dạng số phẳng (`{"1": 1000}`), nhưng cả FE
 * (`buildProxyConfig.ts` đọc `pricing[k].price`) lẫn BE (`orders.service.ts`
 * đọc `pricing.price` / `pricing.cost`) đều cần dạng `{ price, cost }`
 * → gói cũ không hiện giá và không mua được. Chuyển đổi tại chỗ.
 * Kèm sửa `usage_type` để chúng rơi đúng trang sản phẩm.
 */
const LEGACY_FIX: Record<string, { usage_type?: string }> = {
  'Proxy IPV4 Private': {},
  'Proxy IPV4 Xoay': { usage_type: 'xoay' },
  'Proxy Ngoại (US)': { usage_type: 'foreign' },
  'Proxy IPV6 Private': {},
  'Proxy IPV6 Xoay Key': { usage_type: 'key_xoay' },
};

export async function seedServices(): Promise<SeedResult> {
  const result = emptyResult();

  const partners = await Service.db.collection('partners').find({}).toArray();
  const countries = await Service.db.collection('countries').find({}).toArray();
  const partnerId = new Map(partners.map((p: any) => [p.code, p._id]));
  const countryId = new Map(countries.map((c: any) => [c.code, c._id]));

  // ─── 1. Chuẩn hoá 5 dịch vụ cũ ─────────────────────────────────────────
  for (const [name, fix] of Object.entries(LEGACY_FIX)) {
    const svc: any = await Service.findOne({ name }).lean().exec();
    if (!svc) continue;

    const patch: Record<string, any> = {};

    const firstValue = Object.values(svc.pricing ?? {})[0];
    if (typeof firstValue === 'number') {
      const converted: Record<string, { price: number; cost: number }> = {};
      for (const [days, price] of Object.entries(svc.pricing as Record<string, number>)) {
        converted[days] = { price, cost: Math.round((price * 0.68) / 100) * 100 };
      }
      patch.pricing = converted;
    }
    if (fix.usage_type && svc.usage_type !== fix.usage_type) {
      patch.usage_type = fix.usage_type;
    }

    if (Object.keys(patch).length === 0) {
      result.skipped++;
      continue;
    }
    await Service.updateOne({ _id: svc._id }, patch).exec();
    result.updated++;
  }

  // ─── 2. Thêm dịch vụ mới ───────────────────────────────────────────────
  for (const s of SERVICES) {
    if (await Service.findOne({ name: s.name }).select('_id').lean().exec()) {
      result.skipped++;
      continue;
    }

    const byBandwidth = s.bandwidthPrice != null;

    await Service.create({
      name: s.name,
      type: s.type,
      status: s.status ?? true,
      proxy_type: s.proxy_type,
      ip_version: s.ip_version,
      partner: partnerId.get(s.partnerCode) ?? null,
      country: s.countryCode ? (countryId.get(s.countryCode) ?? null) : null,
      body_api: '',
      id_service: '',
      protocol: s.protocol,
      note: s.note,
      isp: s.isp,
      usage_type: s.usage_type,
      is_show: true,
      api_enabled: s.api_enabled ?? false,
      show_user_pass: s.show_user_pass ?? true,
      allow_renew: true,
      pricing_mode: byBandwidth ? 'bandwidth' : 'duration',
      pricing: byBandwidth ? gbTiers(s.bandwidthPrice!) : (s.pricing ?? {}),
      bandwidth_tiers: byBandwidth ? gbBands(s.bandwidthPrice!) : [],
      bandwidth_max_gb: byBandwidth ? 500 : 1000,
      user_discounts: {},
      min_quantity: s.min_quantity,
      max_quantity: s.max_quantity,
      badge: s.badge ?? '',
      duration_ids: {},
      order: s.order,
    });
    result.created++;
  }

  return result;
}
