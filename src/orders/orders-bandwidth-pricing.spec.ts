import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { BuyOrderDto } from '../dto/buy-order.dto';

/**
 * Kiểm tra phần tính tiền theo bậc GB.
 *
 * `resolveBandwidthTier` và `resolvePricing` là hàm thuần — chỉ đọc tham số,
 * không chạm vào model hay redis — nên dựng prototype trần là đủ, không cần
 * nhấc cả DI container của Nest lên.
 */
type PricingHost = {
  resolvePricing(service: any, dto: BuyOrderDto, userId: string): any;
  resolveBandwidthTier(service: any, rawGb: number): any;
};

const svc = Object.create(OrdersService.prototype) as PricingHost;

const TIERS = [
  { min_gb: 1, price_per_gb: 20000, cost_per_gb: 12400, days: 30 },
  { min_gb: 10, price_per_gb: 17000, cost_per_gb: 11800, days: 30 },
  { min_gb: 50, price_per_gb: 14000, cost_per_gb: 10900, days: 60 },
  { min_gb: 100, price_per_gb: 12000, cost_per_gb: 10200, days: 0 },
];

function service(overrides: Record<string, any> = {}) {
  return {
    pricing_mode: 'bandwidth',
    pricing: {},
    bandwidth_tiers: TIERS,
    bandwidth_max_gb: 1000,
    user_discounts: {},
    ...overrides,
  };
}

const price = (gb: number, s = service(), userId = 'u1') =>
  svc.resolvePricing(s, { service_id: 'x', gb } as BuyOrderDto, userId);

describe('bậc giá theo GB', () => {
  it('tính giá phẳng theo bậc đang đứng, không luỹ tiến từng bậc', () => {
    // 50 GB nằm trọn trong bậc 14.000đ — không cộng dồn phần 1–9 và 10–49.
    expect(price(50).totalPrice).toBe(700_000);
    expect(price(5).totalPrice).toBe(100_000);
    expect(price(30).totalPrice).toBe(510_000);
  });

  it('chọn đúng bậc ở hai đầu ranh giới', () => {
    expect(svc.resolveBandwidthTier(service(), 9).tier.price_per_gb).toBe(20000);
    expect(svc.resolveBandwidthTier(service(), 10).tier.price_per_gb).toBe(17000);
    expect(svc.resolveBandwidthTier(service(), 49).tier.price_per_gb).toBe(17000);
    expect(svc.resolveBandwidthTier(service(), 50).tier.price_per_gb).toBe(14000);
  });

  it('giữ nguyên nghịch giá: mua nhiều hơn có thể rẻ hơn', () => {
    // Đây là hệ quả có chủ đích của giá phẳng. Nếu test này đổ, ai đó đã lặng
    // lẽ chuyển sang luỹ tiến — và giao diện gợi ý lên bậc sẽ nói dối.
    expect(price(50).totalPrice).toBeLessThan(price(49).totalPrice);
  });

  it('sắp xếp bậc do admin nhập lộn xộn', () => {
    const shuffled = service({ bandwidth_tiers: [TIERS[2], TIERS[0], TIERS[3], TIERS[1]] });
    expect(price(50, shuffled).totalPrice).toBe(700_000);
    expect(price(5, shuffled).totalPrice).toBe(100_000);
  });

  it('bỏ qua bậc rác thay vì tính sai', () => {
    const dirty = service({
      bandwidth_tiers: [
        { min_gb: 0, price_per_gb: 1 },
        { min_gb: 10, price_per_gb: 0 },
        ...TIERS,
      ],
    });
    expect(price(50, dirty).totalPrice).toBe(700_000);
  });

  it('days = 0 nghĩa là không giới hạn thời gian, không phải hết hạn ngay', () => {
    expect(price(100).durationDays).toBe(0);
    expect(price(50).durationDays).toBe(60);
  });

  it('tính giá vốn theo GB để biên lợi nhuận không lệch', () => {
    expect(price(50).totalCost).toBe(545_000);
    expect(price(100).totalCost).toBe(1_020_000);
  });

  it('giá vốn null khi bậc chưa khai cost', () => {
    const noCost = service({
      bandwidth_tiers: [{ min_gb: 1, price_per_gb: 20000, days: 30 }],
    });
    expect(price(5, noCost).totalCost).toBeNull();
  });

  it('áp ưu đãi riêng theo từng GB', () => {
    const discounted = service({ user_discounts: { u1: { per_gb: 2000 } } });
    const r = price(50, discounted);
    expect(r.basePrice).toBe(700_000);
    expect(r.discountAmount).toBe(100_000);
    expect(r.totalPrice).toBe(600_000);
  });

  it('ưu đãi không kéo giá xuống âm', () => {
    const absurd = service({ user_discounts: { u1: { per_gb: 999_999 } } });
    expect(price(50, absurd).totalPrice).toBe(0);
  });

  it('không áp ưu đãi của user khác', () => {
    const discounted = service({ user_discounts: { someone_else: { per_gb: 2000 } } });
    expect(price(50, discounted, 'u1').totalPrice).toBe(700_000);
  });

  it('chặn số GB ngoài khoảng', () => {
    expect(() => price(0)).toThrow(BadRequestException);
    expect(() => price(1001)).toThrow(BadRequestException);
    expect(() => price(-5)).toThrow(BadRequestException);
  });

  it('chặn khi dịch vụ chưa cấu hình bậc nào', () => {
    expect(() => price(50, service({ bandwidth_tiers: [] }))).toThrow(BadRequestException);
  });

  it('mỗi đơn theo GB là một gateway, không nhân số lượng', () => {
    expect(price(50).quantity).toBe(1);
    expect(price(50).bandwidthGb).toBe(50);
  });

  it('gói cố định cũ vẫn chạy khi không gửi gb', () => {
    const legacy = {
      pricing_mode: 'bandwidth',
      pricing: { '50': { gb: 50, days: 30, price: 650_000, cost: 400_000 } },
      bandwidth_tiers: [],
      user_discounts: {},
    };
    const r = svc.resolvePricing(
      legacy,
      { service_id: 'x', package_key: '50' } as BuyOrderDto,
      'u1',
    );
    expect(r.totalPrice).toBe(650_000);
    expect(r.bandwidthGb).toBe(50);
    expect(r.durationDays).toBe(30);
  });
});
