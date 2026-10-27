import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { ORDER_WORKER_READY_KEY } from './worker-readiness';

describe('Checkout readiness before wallet deduction', () => {
  const previous = process.env.PURCHASE_ENABLED;
  let svc: any;
  let service: any;
  let partner: any;
  let provider: any;
  beforeEach(() => {
    process.env.PURCHASE_ENABLED = 'true';
    service = {
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
    }));
    svc.resolveCountryId = jest.fn().mockResolvedValue(null);
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
  it('rejects failed catalog/stock/quote preflight without charging', async () => {
    provider.preflightBuy.mockRejectedValue(
      new BadRequestException('Invalid quote'),
    );
    await expect(buy()).rejects.toThrow('Invalid quote');
    untouched();
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
