import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { ORDER_WORKER_READY_KEY } from './worker-readiness';
import { CountryPolicyService } from '../countries/country-policy.service';
import { HomeproxyProvider } from '../proxy-providers/impl/homeproxy.provider';
import { Proxyv6Provider } from '../proxy-providers/impl/proxyv6.provider';

describe('Checkout readiness before wallet deduction', () => {
  const previous = process.env.PURCHASE_ENABLED;
  let svc: any;
  let service: any;
  let partner: any;
  let provider: any;
  beforeEach(() => {
    process.env.PURCHASE_ENABLED = 'true';
    service = {
      name: 'Country service',
      status: true,
      api_enabled: true,
      partner: 'partner',
      id_service: '42',
      body_api: '{}',
    };
    partner = { status: true, code: 'gpnip', token_api: 'test-only-key' };
    provider = {
      capabilities: { buy: true },
      validateBuy: jest.fn(),
      preflightBuy: jest.fn(),
    };
    svc = Object.create(OrdersService.prototype);
    svc.serviceModel = {
      findById: jest.fn(() => ({ exec: async () => service })),
    };
    svc.partnerModel = {
      findById: jest.fn(() => ({ exec: async () => partner })),
    };
    svc.userModel = {
      findOneAndUpdate: jest.fn(() => ({ exec: async () => null })),
    };
    svc.orderModel = jest.fn();
    svc.providerFactory = { getProvider: jest.fn(() => provider) };
    svc.redis = { exists: jest.fn().mockResolvedValue(1), lpush: jest.fn() };
    svc.resolvePricing = jest.fn(() => ({
      pricingMode: 'bandwidth',
      quantity: 1,
      durationDays: 30,
      bandwidthGb: 12,
      totalPrice: 120000,
      pricePerUnit: 120000,
    }));
    svc.resolveCountryId = jest.fn().mockResolvedValue(null);
    svc.countryPolicy = { select: jest.fn().mockResolvedValue(undefined) };
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.PURCHASE_ENABLED;
    else process.env.PURCHASE_ENABLED = previous;
  });
  const buy = () =>
    svc.buy('000000000000000000000001', { service_id: 's', gb: 12 });
  const untouched = () => {
    expect(svc.userModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(svc.orderModel).not.toHaveBeenCalled();
    expect(svc.redis.lpush).not.toHaveBeenCalled();
  };
  it.each(['missing', 'inactive', 'keyless'])(
    'rejects %s partner without charging',
    async (state) => {
      if (state === 'missing') partner = null;
      if (state === 'inactive') partner.status = false;
      if (state === 'keyless') partner.token_api = '  ';
      await expect(buy()).rejects.toBeInstanceOf(BadRequestException);
      untouched();
    },
  );
  it('rejects unknown adapters before charging', async () => {
    svc.providerFactory.getProvider.mockImplementation(() => {
      throw new BadRequestException('Unknown adapter');
    });
    await expect(buy()).rejects.toThrow('Unknown adapter');
    untouched();
  });
  it('rejects providers without buy capability', async () => {
    provider.capabilities.buy = false;
    await expect(buy()).rejects.toBeInstanceOf(BadRequestException);
    untouched();
  });
  it('rejects invalid package configuration before charging', async () => {
    provider.validateBuy.mockImplementation(() => {
      throw new BadRequestException('Missing package');
    });
    await expect(buy()).rejects.toThrow('Missing package');
    untouched();
  });
  it('rejects offline workers before any external preflight or charge', async () => {
    svc.redis.exists.mockResolvedValue(0);
    await expect(buy()).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.redis.exists).toHaveBeenCalledWith(ORDER_WORKER_READY_KEY);
    expect(provider.preflightBuy).not.toHaveBeenCalled();
    untouched();
  });
  it.each([undefined, 'SAVE'])('rejects unsupported adapter product mapping precharge voucher=%s', async voucher_code => {
    partner.code = 'proxyv6';
    provider = new Proxyv6Provider();
    service.isp = [{ name: 'Variant', code: 'variant', provider_product_id: 'mapped' }];
    service.country_source = 'manual';
    service.country_options = [{ code: 'US' }];
    svc.countryPolicy = new CountryPolicyService(svc.partnerModel, {} as any, svc.providerFactory);
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn() };
    await expect(svc.buy('000000000000000000000001', { service_id: 's', isp: 'variant', voucher_code }, voucher_code ? 'unsupported' : undefined)).rejects.toThrow('does not support explicit product mapping');
    untouched();
    expect(svc.vouchers.purchase).not.toHaveBeenCalled();
  });
  it.each([undefined, 'SAVE'])('allows ProxyV6 legacy ISP and service ID with manual country voucher=%s', async voucher_code => {
    partner.code = 'proxyv6';
    provider = new Proxyv6Provider();
    const validate = jest.spyOn(provider, 'validateBuy');
    service.isp = [{ name: 'FPT', code: 'fpt' }];
    service.country_source = 'manual';
    service.country_options = [{ code: 'US' }];
    svc.countryPolicy = new CountryPolicyService(svc.partnerModel, {} as any, svc.providerFactory);
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn().mockResolvedValue({ success: true }) };
    const request = svc.buy('000000000000000000000001', { service_id: '000000000000000000000002', isp: 'fpt', country: 'US', voucher_code }, voucher_code ? 'country-only' : undefined);
    if (voucher_code) {
      await request;
      expect(svc.vouchers.purchase.mock.calls[0][3].config).toMatchObject({
        country_policy: { code: 'US', package_id: '42' },
        product_mapping: { product_id: '42', product_id_configured: false },
      });
    } else {
      await expect(request).rejects.toThrow('Số dư'); // Reached mock wallet, not mapping rejection.
      expect(svc.userModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    }
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ id_service: '42', isp: 'fpt', country_code: 'US', product_id_configured: false }));
  });
  it.each([undefined, 'SAVE'])('rejects genuine ProxyV6 service-duration mapping with country precharge voucher=%s', async voucher_code => {
    partner.code = 'proxyv6';
    provider = new Proxyv6Provider();
    service.duration_ids = { '30': 'mapped-month' };
    service.country_source = 'manual';
    service.country_options = [{ code: 'US' }];
    svc.countryPolicy = new CountryPolicyService(svc.partnerModel, {} as any, svc.providerFactory);
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn() };
    await expect(svc.buy('000000000000000000000001', { service_id: 's', country: 'US', voucher_code }, voucher_code ? 'duration' : undefined)).rejects.toThrow('does not support explicit product mapping');
    untouched();
    expect(svc.vouchers.purchase).not.toHaveBeenCalled();
  });
  it.each([
    [undefined, 60, '{}'], ['SAVE', 60, '{}'],
    [undefined, undefined, '{"rotate_interval":60}'], ['SAVE', undefined, '{"rotate_interval":60}'],
  ])('rejects mapped static FPT with effective rotation before charge voucher=%s dto=%s', async (voucher_code, rotate_interval, body) => {
    partner.code = 'homeproxy';
    provider = new HomeproxyProvider();
    service.type = 'static';
    service.body_api = body;
    service.isp = [{ name: 'FPT FP1', code: 'fpt_fp1', provider_product_id: 'fp1', provider_isp: 'FPT' }];
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn() };
    await expect(svc.buy('000000000000000000000001', { service_id: 's', isp: 'fpt_fp1', rotate_interval, voucher_code }, voucher_code ? 'rotation' : undefined)).rejects.toThrow('provider_isp');
    untouched();
    expect(svc.vouchers.purchase).not.toHaveBeenCalled();
  });
  it.each([undefined, 'SAVE'])('preflight gets effective rotation with nullish DTO precedence voucher=%s', async voucher_code => {
    service.body_api = '{"rotate_interval":60}';
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn().mockResolvedValue({ success: true }) };
    const dto = { service_id: '000000000000000000000002', rotate_interval: 0, voucher_code };
    const request = svc.buy('000000000000000000000001', dto, voucher_code ? 'rotation' : undefined);
    if (voucher_code) await request; else await expect(request).rejects.toThrow();
    expect(provider.validateBuy).toHaveBeenCalledWith(expect.objectContaining({ rotate_interval: 0 }));
    expect(provider.preflightBuy).toHaveBeenCalledWith(expect.objectContaining({ rotate_interval: 0 }));
    if (voucher_code) expect(svc.vouchers.purchase.mock.calls[0][3].config.rotate_interval).toBe(0);
  });
  it('snapshots template rotation exactly as validated before voucher purchase', async () => {
    service.body_api = '{"rotate_interval":60}';
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn().mockResolvedValue({ success: true }) };
    await svc.buy('000000000000000000000001', { service_id: '000000000000000000000002', voucher_code: 'SAVE' }, 'rotation');
    expect(provider.validateBuy).toHaveBeenCalledWith(expect.objectContaining({ rotate_interval: 60 }));
    expect(svc.vouchers.purchase.mock.calls[0][3].config.rotate_interval).toBe(60);
  });
  it('rejects failed catalog/stock/quote preflight without charging', async () => {
    provider.preflightBuy.mockRejectedValue(
      new BadRequestException('Invalid quote'),
    );
    await expect(buy()).rejects.toThrow('Invalid quote');
    untouched();
  });
  it.each([undefined, 'SAVE'])('country rejection precedes all charges for voucher=%s', async (voucher_code) => {
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn() };
    svc.countryPolicy.select.mockRejectedValue(new BadRequestException('Select an available country'));
    await expect(svc.buy('000000000000000000000001', { service_id: 's', gb: 12, country: 'ZZ', voucher_code }, voucher_code ? 'country-test' : undefined)).rejects.toThrow('Select an available country');
    untouched();
    expect(svc.vouchers.purchase).not.toHaveBeenCalled();
    expect(provider.preflightBuy).not.toHaveBeenCalled();
  });
  it('quote rejects country before issuing voucher quote', async () => {
    svc.vouchers = { rateLimit: jest.fn(), quote: jest.fn() };
    svc.countryPolicy.select.mockRejectedValue(new BadRequestException('Select an available country'));
    await expect(svc.quote('user', { service_id: 's' })).rejects.toThrow('Select an available country');
    expect(svc.vouchers.quote).not.toHaveBeenCalled();
  });
  it.each([undefined, 'SAVE'])('invalid variant rejects before charge for voucher=%s', async voucher_code => {
    service.isp = [{ name: 'FPT FP1', code: 'fpt_fp1', provider_product_id: 'fp1' }];
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn() };
    await expect(svc.buy('000000000000000000000001', { service_id: 's', isp: 'fpt', voucher_code }, voucher_code ? 'variant' : undefined)).rejects.toThrow('Unknown ISP');
    untouched();
    expect(svc.vouchers.purchase).not.toHaveBeenCalled();
    expect(provider.preflightBuy).not.toHaveBeenCalled();
  });
  it('quote rejects unmapped duration before voucher quote', async () => {
    service.isp = [{ name: 'FPT FP1', code: 'fpt_fp1', duration_ids: { '7': 'fp1-week' } }];
    svc.vouchers = { rateLimit: jest.fn(), quote: jest.fn() };
    await expect(svc.quote('user', { service_id: 's', isp: 'fpt_fp1' })).rejects.toThrow('no product');
    expect(svc.vouchers.quote).not.toHaveBeenCalled();
  });
  it('voucher snapshots the variant and upstream ISP before purchase', async () => {
    service.isp = [{ name: 'FPT FP1', code: 'fpt_fp1', provider_product_id: 'fp1', provider_isp: 'FPT' }];
    svc.countryPolicy.select.mockResolvedValue({ source: 'none', package_id: 'wrong-country-package' });
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn().mockResolvedValue({ success: true }) };
    await svc.buy('000000000000000000000001', { service_id: '000000000000000000000002', isp: 'fpt_fp1', voucher_code: 'SAVE' }, 'variant');
    expect(provider.preflightBuy).toHaveBeenCalledWith(expect.objectContaining({ id_service: 'fp1', isp: 'FPT', product_id_configured: true }));
    expect(svc.vouchers.purchase.mock.calls[0][3].config).toMatchObject({ isp: 'fpt_fp1', product_mapping: { product_id: 'fp1', provider_isp: 'FPT' } });
  });
  it.each([undefined, 'SAVE'])('real resolver rejects unsupported manual selection before charge, voucher=%s', async (voucher_code) => {
    partner.code = 'proxyvn';
    service.country_source = 'manual';
    service.country_options = [{ code: 'US' }];
    svc.countryPolicy = new CountryPolicyService(svc.partnerModel, {} as any, svc.providerFactory);
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn() };
    await expect(svc.buy('000000000000000000000001', { service_id: 's', gb: 12, voucher_code }, voucher_code ? 'unsupported' : undefined))
      .rejects.toThrow('Country selection is not supported by this provider adapter');
    untouched();
    expect(svc.vouchers.purchase).not.toHaveBeenCalled();
    expect(provider.preflightBuy).not.toHaveBeenCalled();
  });
  it.each(['packageId', 'id'])('template-only GPNIP %s resolves same coverage, preflight and voucher snapshot', async (key) => {
    service.country_source = 'api';
    service.id_service = '';
    service.body_api = JSON.stringify({ [key]: 77 });
    provider.capabilities.countrySelection = true;
    provider.listCountriesForPackage = jest.fn().mockResolvedValue({ iso_codes: ['US'] });
    svc.countryPolicy = new CountryPolicyService(svc.partnerModel, {} as any, svc.providerFactory);
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn().mockResolvedValue({ success: true }) };
    await svc.buy('000000000000000000000001', { service_id: '000000000000000000000002', gb: 12, voucher_code: 'SAVE' }, 'template-package');
    expect(provider.listCountriesForPackage).toHaveBeenCalledWith('test-only-key', '77');
    expect(provider.preflightBuy).toHaveBeenCalledWith(expect.objectContaining({ id_service: '77', country_code: 'US' }));
    expect(svc.vouchers.purchase.mock.calls[0][3].config.country_policy).toMatchObject({ package_id: '77', code: 'US' });
  });
  it.each([undefined, 'SAVE'])('passes authoritative country/package to preflight for voucher=%s', async (voucher_code) => {
    svc.vouchers = { existing: jest.fn().mockResolvedValue(null), purchase: jest.fn().mockResolvedValue({ success: true }) };
    svc.countryPolicy.select.mockResolvedValue({ source: 'manual', code: 'US', provider_value: 'mapped', package_id: 'duration-package' });
    const request = svc.buy('000000000000000000000001', { service_id: '000000000000000000000002', gb: 12, voucher_code }, voucher_code ? 'country-test' : undefined);
    if (voucher_code) await request;
    else await expect(request).rejects.toThrow();
    expect(provider.preflightBuy).toHaveBeenCalledWith(expect.objectContaining({ country_policy_configured: true, country_code: 'US', country_provider_value: 'mapped', id_service: 'duration-package' }));
    if (voucher_code) {
      expect(svc.vouchers.purchase).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ config: expect.objectContaining({ country_policy: { source: 'manual', code: 'US', provider_value: 'mapped', package_id: 'duration-package' } }) }), expect.anything());
      expect(provider.preflightBuy.mock.invocationCallOrder[0]).toBeLessThan(svc.vouchers.purchase.mock.invocationCallOrder[0]);
    }
  });
  it('passes actual billed GB and duration to preflight before wallet access', async () => {
    await expect(buy()).rejects.toThrow(); // Mock wallet has insufficient balance: no real order.
    expect(provider.preflightBuy).toHaveBeenCalledWith(
      expect.objectContaining({
        bandwidth_gb: 12,
        pricing_mode: 'bandwidth',
        quantity: 1,
        duration_days: 30,
      }),
    );
    expect(provider.preflightBuy.mock.invocationCallOrder[0]).toBeLessThan(
      svc.userModel.findOneAndUpdate.mock.invocationCallOrder[0],
    );
    expect(svc.orderModel).not.toHaveBeenCalled();
  });
  it('rejects partial GPNIP renewal before wallet deduction', async () => {
    await expect(
      svc.renewOrderProxies({
        order: {
          _id: '000000000000000000000009',
          partner_id: partner,
          service_id: {},
          quantity: 3,
        },
        proxies: [{ provider_proxy_id: 'local-1' }],
        duration_days: 30,
        userId: '000000000000000000000001',
        chargeQuantity: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    untouched();
  });
  it('rejects bandwidth and expired GPNIP time renewals locally', () => {
    const order = {
      status: 3,
      partner_id: partner,
      service_id: {},
      provider_order_id: '9',
      pricing_mode: 'bandwidth',
    };
    expect(svc.checkOrderRenewable(order)).not.toBeNull();
    expect(
      svc.checkOrderRenewable({
        ...order,
        pricing_mode: 'duration',
        end_date: new Date(0),
      }),
    ).not.toBeNull();
    expect(
      svc.checkOrderRenewable({
        ...order,
        pricing_mode: 'duration',
        end_date: new Date(Date.now() + 86400000),
      }),
    ).toBeNull();
  });
  it('blocks admin retry of an ambiguous GPNIP order before deleting proxies or ID', async () => {
    const order = {
      status: 9,
      config: { gpnip_purchase_started: true },
      provider_order_id: '9',
    };
    svc.orderModel = { findById: () => ({ exec: async () => order }) };
    svc.proxyModel = { deleteMany: jest.fn() };
    await expect(
      svc.retryOrder('000000000000000000000009'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.proxyModel.deleteMany).not.toHaveBeenCalled();
    expect(order.provider_order_id).toBe('9');
  });
});
