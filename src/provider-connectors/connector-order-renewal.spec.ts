import { ConnectorOrderRenewal } from './connector-order-renewal.service';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';
import { homeproxyPurchaseCandidate } from './homeproxy-template';

describe('Connector order renewal', () => {
  const id = '507f1f77bcf86cd799439011';
  const user = '507f1f77bcf86cd799439022';
  const key = 'renew-key-1';
  const endDate = new Date(Date.now() + 2 * 86400_000);

  function fixture() {
    const binding = { accountId: id, connectorCode: 'homeproxy_static_http_candidate', connectorVersion: 5,
      input: { packageId: 'p', quantity: 2, durationDays: 1, protocol: 'http', username: 'u', password: 'p' } };
    const order = { _id: id, order_code: 'ORD-1', user_id: user, service_id: id, quantity: 2, actual_quantity: 2,
      connector_purchase: binding, connector_purchase_state: 'delivered', connector_renewal: null,
      connector_renewal_state: null, status: OrderStatusEnum.ACTIVE, payment_status: PaymentStatusEnum.PAID,
      voucher_snapshot: null, end_date: endDate };
    const query = (value: unknown) => ({ select: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(value) });
    const session = { withTransaction: jest.fn(async (callback: () => Promise<void>) => callback()), endSession: jest.fn() };
    let receipt: unknown = null;
    let usedKey: unknown = null;
    const orders = { findOne: jest.fn((filter: any) => query(filter?.connector_renewal_key ? receipt
      : filter?.connector_renewal_keys ? usedKey : order)),
      findById: jest.fn(() => query(order)),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }), db: { startSession: jest.fn().mockResolvedValue(session) } };
    const proxies = { find: jest.fn(() => query([{ provider_proxy_id: '1683054' }, { provider_proxy_id: '1683055' }])) };
    const service = { _id: id, name: 'HomeProxy VIETTEL', pricing_mode: 'duration',
      pricing: { 1: { price: 1500 }, 7: { price: 9900 } },
      connector_binding: { accountId: id, connectorCode: 'homeproxy_static_http_candidate', connectorVersion: 5, packages: {} } };
    const services = { findById: jest.fn(() => query(service)) };
    const users = { findOneAndUpdate: jest.fn((_filter: any, _update?: any) => query({ money: 7000 })) };
    const wallet = { create: jest.fn() };
    const account = { enabled: true, connectorCode: 'homeproxy_static_http_candidate', connectorVersion: 5, credential: 'encrypted' };
    const accounts = { findById: jest.fn(() => query(account)) };
    const connectors = { publishedDefinition: jest.fn().mockResolvedValue(homeproxyPurchaseCandidate('VIETTEL', 'http')) };
    const secrets = { decrypt: jest.fn().mockReturnValue('account-secret') };
    const dispatches = { claim: jest.fn().mockResolvedValue({ acquired: true, id, owner: 'owner' }),
      submitted: jest.fn(), saveResult: jest.fn(), complete: jest.fn(), unknown: jest.fn() };
    const http = { execute: jest.fn().mockResolvedValue({ status: 'success' }) };
    const config = { get: jest.fn(() => 'true') };
    const sut = new ConnectorOrderRenewal(orders as any, proxies as any, services as any, users as any,
      wallet as any, accounts as any, connectors as any, secrets as any, dispatches as any, http as any, config as any);
    return { sut, order, orders, proxies, service, services, users, wallet, accounts, connectors, dispatches, http, config,
      session, storeReceipt: (value: unknown) => { receipt = value; },
      storeUsedKey: (value: unknown) => { usedKey = value; } };
  }
  const run = (f: ReturnType<typeof fixture>, durationDays = 1) =>
    f.sut.renew({ userId: user, orderId: id, durationDays, key });

  it('charges once, sends the pinned proxies and extends from the old expiry', async () => {
    const f = fixture();
    const result = await run(f, 7);
    expect(f.users.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(f.users.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ money: { $gte: 19800 } });
    expect(f.wallet.create.mock.calls[0][0][0]).toMatchObject({ type: 'renew', amount: 19800, direction: 'out' });
    expect(f.http.execute).toHaveBeenCalledTimes(1);
    const sent = f.http.execute.mock.calls[0];
    expect(sent[2]).toEqual({ providerProxyIds: [1683054, 1683055], durationDays: 7 });
    const extension = f.orders.updateOne.mock.calls.at(-1)![1].$set;
    // Về null, không phải 'renewed': chu kỳ sau đơn phải gia hạn lại được.
    expect(extension.connector_renewal_state).toBeNull();
    expect(extension.end_date.getTime()).toBe(endDate.getTime() + 7 * 86400_000);
    expect(f.orders.updateOne.mock.calls.at(-1)![1].$inc).toEqual({ renew_count: 1 });
    expect(result).toMatchObject({ state: 'renewed', duration_days: 7, price: 19800 });
  });

  it('stays closed until renewal is explicitly enabled, without charging', async () => {
    const f = fixture();
    f.config.get = jest.fn(() => 'false') as never;
    await expect(run(f)).rejects.toThrow('chưa được kích hoạt');
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.http.execute).not.toHaveBeenCalled();
  });

  it('answers a repeated key from the stored receipt without charging or sending again', async () => {
    const f = fixture();
    await run(f);
    const charged = { ...f.order, connector_renewal_hash: undefined as unknown as string,
      connector_renewal: { input: { providerProxyIds: [1683054, 1683055], durationDays: 1 }, price: 3000 },
      connector_renewal_state: null };
    const hash = f.orders.updateOne.mock.calls[0][1].$set.connector_renewal_hash;
    charged.connector_renewal_hash = hash;
    f.users.findOneAndUpdate.mockClear(); f.http.execute.mockClear();
    f.storeReceipt(charged);
    expect(await run(f)).toMatchObject({ state: 'renewed', duration_days: 1, price: 3000 });
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.http.execute).not.toHaveBeenCalled();
  });

  it('refuses a reused key that carries a different renewal', async () => {
    const f = fixture();
    f.storeReceipt({ ...f.order, connector_renewal_hash: 'another-payload' });
    await expect(run(f)).rejects.toThrow('idempotency');
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each(['status', 'voucher', 'not-delivered', 'renewal-in-flight', 'expired', 'unpaid'])(
    'refuses a non-renewable order (%s) before charging', async reason => {
      const f = fixture();
      if (reason === 'status') (f.order as any).status = OrderStatusEnum.PROCESSING;
      if (reason === 'voucher') (f.order as any).voucher_snapshot = { code: 'X' };
      if (reason === 'not-delivered') (f.order as any).connector_purchase_state = 'reconciliation';
      if (reason === 'renewal-in-flight') (f.order as any).connector_renewal_state = 'dispatching';
      if (reason === 'expired') (f.order as any).end_date = new Date(Date.now() - 1000);
      if (reason === 'unpaid') (f.order as any).payment_status = PaymentStatusEnum.UNPAID;
      await expect(run(f)).rejects.toThrow();
      expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
      expect(f.http.execute).not.toHaveBeenCalled();
    });

  it('refuses when the pinned version has no renewal action', async () => {
    const f = fixture();
    const definition = homeproxyPurchaseCandidate('VIETTEL', 'http');
    delete definition.actions.renew;
    f.connectors.publishedDefinition = jest.fn().mockResolvedValue(definition) as never;
    await expect(run(f)).rejects.toThrow('không hỗ trợ gia hạn');
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each(['missing-id', 'count-mismatch', 'duplicate-id', 'empty'])(
    'refuses an incomplete proxy inventory (%s)', async reason => {
      const f = fixture();
      const rows = reason === 'missing-id' ? [{ provider_proxy_id: '1683054' }, { provider_proxy_id: '' }]
        : reason === 'count-mismatch' ? [{ provider_proxy_id: '1683054' }]
        : reason === 'duplicate-id' ? [{ provider_proxy_id: '1683054' }, { provider_proxy_id: '1683054' }] : [];
      f.proxies.find = jest.fn(() => ({ select: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(rows) })) as never;
      await expect(run(f)).rejects.toThrow('đối soát');
      expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
      expect(f.http.execute).not.toHaveBeenCalled();
    });

  it('refuses a duration the service does not sell', async () => {
    const f = fixture();
    await expect(run(f, 30)).rejects.toThrow('không bán mốc thời hạn này');
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('stops at reconciliation when the provider rejects, without refunding or resending', async () => {
    const f = fixture();
    f.http.execute = jest.fn().mockResolvedValue({ status: 'pending' }) as never;
    await expect(run(f)).rejects.toThrow('đối soát');
    expect(f.wallet.create).toHaveBeenCalledTimes(1);
    expect(f.dispatches.unknown).toHaveBeenCalled();
    const last = f.orders.updateOne.mock.calls.at(-1)!;
    expect(last[0]).toMatchObject({ connector_renewal_state: 'dispatching' });
    expect(last[1].$set.connector_renewal_state).toBe('reconciliation');
    expect(last[1].$set).not.toHaveProperty('end_date');
  });

  it('does not charge when the balance is short', async () => {
    const f = fixture();
    f.users.findOneAndUpdate = jest.fn(() => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null) })) as never;
    await expect(run(f)).rejects.toThrow('Số dư không đủ');
    expect(f.wallet.create).not.toHaveBeenCalled();
    expect(f.http.execute).not.toHaveBeenCalled();
  });

  it('renews again after a finished renewal, charging the new key once', async () => {
    const f = fixture();
    (f.order as any).connector_renewal = { input: { providerProxyIds: [1683054, 1683055], durationDays: 1 }, price: 3000 };
    (f.order as any).renew_count = 1;
    await run(f);
    const claim = f.orders.updateOne.mock.calls[0];
    // Ảnh chụp của lượt cũ không được chặn lượt mới; chỉ trạng thái đang chạy mới chặn.
    expect(claim[0]).not.toHaveProperty('connector_renewal');
    expect(claim[0].connector_renewal_state).toBeNull();
    expect(claim[1].$addToSet).toEqual({ connector_renewal_keys: expect.any(String) });
    expect(f.users.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('honours the admin renewal switch on the service, on both the quote and the charge', async () => {
    const f = fixture();
    (f.service as any).allow_renew = false;
    await expect(run(f)).rejects.toThrow('không hỗ trợ gia hạn');
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
    expect(await f.sut.options(user, id)).toMatchObject({ enabled: false, reason: 'Dịch vụ này không hỗ trợ gia hạn' });
  });

  it('refuses a key already spent on an earlier renewal instead of charging again', async () => {
    const f = fixture();
    f.storeUsedKey({ _id: id });
    await expect(run(f)).rejects.toThrow('đã dùng cho một lượt gia hạn trước');
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.http.execute).not.toHaveBeenCalled();
  });

  describe('renewal quote', () => {
    it('prices every duration the service sells, for the proxies the order holds', async () => {
      const f = fixture();
      expect(await f.sut.options(user, id)).toMatchObject({ mode: 'connector', enabled: true, reason: null,
        proxy_count: 2, options: [{ duration_days: 1, unit_price: 1500, price: 3000 },
          { duration_days: 7, unit_price: 9900, price: 19800 }] });
      expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
      expect(f.http.execute).not.toHaveBeenCalled();
    });

    it('explains instead of quoting while renewal is switched off', async () => {
      const f = fixture();
      f.config.get = jest.fn(() => undefined) as never;
      expect(await f.sut.options(user, id)).toMatchObject({ enabled: false, options: [],
        reason: 'Gia hạn qua nhà cung cấp đang tạm khoá' });
    });

    it('refuses to quote an order whose pinned version cannot renew', async () => {
      const f = fixture();
      const definition = homeproxyPurchaseCandidate('VIETTEL', 'http');
      delete definition.actions.renew;
      f.connectors.publishedDefinition = jest.fn().mockResolvedValue(definition) as never;
      const quote = await f.sut.options(user, id);
      expect(quote).toMatchObject({ enabled: false, options: [] });
      expect(quote.reason).toContain('chưa gia hạn được');
    });

    it('still reports how many proxies the order holds when an upstream id is missing', async () => {
      const f = fixture();
      f.proxies.find = jest.fn(() => ({ select: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([{ provider_proxy_id: '1683054' }, { provider_proxy_id: '' }]) })) as never;
      const quote = await f.sut.options(user, id);
      expect(quote).toMatchObject({ enabled: false, proxy_count: 2, options: [] });
      expect(quote.reason).toContain('đối soát');
    });

    it('says which renewal path owns the order', async () => {
      const f = fixture();
      expect(await f.sut.mode(user, id)).toBe('connector');
      (f.order as any).connector_purchase = null;
      expect(await f.sut.mode(user, id)).toBe('legacy');
    });
  });
});
