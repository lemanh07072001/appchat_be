import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ProxyProvidersModule } from './proxy-providers.module';
import { ProxyProviderFactory } from './proxy-provider.factory';
import { ProxyProvider } from './proxy-provider.decorator';

/**
 * Registry adapter là nguồn duy nhất cho ô chọn adapter ở màn hình nhà cung
 * cấp. Sai ở đây thì admin lưu được một cấu hình chỉ vỡ lúc khách bấm mua.
 */
describe('ProxyProviderFactory', () => {
  let factory: ProxyProviderFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProxyProvidersModule],
    }).compile();
    await moduleRef.init();
    factory = moduleRef.get(ProxyProviderFactory);
  });

  it('liệt kê đúng những adapter đã đăng ký', () => {
    const codes = factory.listProviders().map((p) => p.code);
    expect(new Set(codes)).toEqual(
      new Set([
        'proxyv6',
        'homeproxy',
        'proxyvn',
        'proxysieutoc',
        'twoproxy',
        'proxyseller',
        'omoproxy',
      ]),
    );
  });

  it('trả về danh sách đã sắp xếp để giao diện không nhảy thứ tự', () => {
    const codes = factory.listProviders().map((p) => p.code);
    expect(codes).toEqual([...codes].sort());
  });

  it('khai đúng provider không gia hạn / xoay IP được', () => {
    const byCode = Object.fromEntries(factory.listProviders().map((p) => [p.code, p.capabilities]));

    // ProxySieuToc ném "chưa hỗ trợ" ở cả ba — phải hiện ra ở đây.
    expect(byCode['proxysieutoc'].renew).toBe(false);
    expect(byCode['proxysieutoc'].rotate).toBe(false);
    expect(byCode['proxysieutoc'].cancel).toBe(false);
    expect(byCode['proxysieutoc'].buy).toBe(true);

    expect(byCode['proxyseller'].renew).toBe(true);
    expect(byCode['proxyseller'].rotate).toBe(false);

    expect(byCode['homeproxy'].rotate).toBe(true);
  });

  it('chỉ OmoProxy đọc được lưu lượng — đó là provider duy nhất bán theo GB', () => {
    const usage = factory
      .listProviders()
      .filter((p) => p.capabilities.usage)
      .map((p) => p.code);
    expect(usage).toEqual(['omoproxy']);
  });

  it('chỉ OmoProxy nạp thêm GB được — cùng lý do: provider duy nhất bán theo GB', () => {
    const topup = factory
      .listProviders()
      .filter((p) => p.capabilities.topup)
      .map((p) => p.code);
    expect(topup).toEqual(['omoproxy']);
  });

  it('OmoProxy mua/gia hạn được, nhưng không xoay IP và không huỷ đơn', () => {
    const omo = factory.listProviders().find((p) => p.code === 'omoproxy')!;
    expect(omo.capabilities).toMatchObject({
      buy: true,
      renew: true,
      rotate: false,
      cancel: false,
    });
  });

  it('hasProvider phân biệt được code có và không có adapter', () => {
    expect(factory.hasProvider('homeproxy')).toBe(true);
    expect(factory.hasProvider('omoproxy')).toBe(true);
    expect(factory.hasProvider('ncc-chua-co')).toBe(false);
  });

  it('getProvider ném lỗi rõ ràng với code chưa có adapter', () => {
    expect(() => factory.getProvider('khong-ton-tai')).toThrow(BadRequestException);
  });
});

describe('ProxyProviderFactory — tự đăng ký qua decorator', () => {
  it('nổ ngay lúc khởi động khi hai adapter trùng code', async () => {
    @ProxyProvider('trung-code')
    class MotAdapter {}

    @ProxyProvider('trung-code')
    class AdapterKhac {}

    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [ProxyProviderFactory, MotAdapter, AdapterKhac],
    }).compile();

    // Im lặng ghi đè nghĩa là đơn hàng đi qua adapter sai mà không ai biết —
    // thà chết lúc khởi động.
    await expect(moduleRef.init()).rejects.toThrow(/trùng-code|cùng đăng ký code/);
  });

  it('nổ khi không tìm thấy adapter nào', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [ProxyProviderFactory],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(/không tìm thấy adapter/);
  });
});
