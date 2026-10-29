import { ConnectorOrderDelivery } from './connector-order-delivery.service';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';

describe('Transactional Connector delivery', () => {
  const id = '507f1f77bcf86cd799439011';
  function fixture() {
    const binding = { accountId: id, connectorCode: 'example', connectorVersion: 1, input: { orderId: 'untrusted-old-id' } };
    const order = { _id: id, service_id: id, connector_purchase: binding, connector_purchase_state: 'awaiting_delivery',
      status: OrderStatusEnum.PROCESSING, payment_status: PaymentStatusEnum.PAID, provider_order_id: 'paid-order',
      quantity: 1, duration_days: 30 };
    const session = { withTransaction: jest.fn(async callback => callback()), endSession: jest.fn() };
    const orders = { findById: jest.fn(() => ({ lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(order) })),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }), db: { startSession: jest.fn().mockResolvedValue(session) } };
    const proxies = { insertMany: jest.fn() };
    const proxy = { host: 'proxy.example.com', port: 8080, protocol: 'http', username: 'user', password: 'password' };
    const runtime = { read: jest.fn().mockResolvedValue({ fields: {}, items: [proxy] }) };
    const service = new ConnectorOrderDelivery(orders as any, proxies as any, runtime as any);
    return { service, order, orders, proxies, runtime, proxy, session };
  }
  it('pins reads to the purchase binding and atomically creates proxies with ACTIVE status', async () => {
    const f = fixture();
    expect(await f.service.poll(id)).toEqual({ delivered: true, quantity: 1 });
    expect(f.runtime.read).toHaveBeenCalledWith(id, 'fetch', { orderId: 'paid-order' }, f.order.connector_purchase);
    expect(f.orders.updateOne).toHaveBeenCalledWith(expect.objectContaining({
      connector_purchase: f.order.connector_purchase, payment_status: PaymentStatusEnum.PAID,
      connector_purchase_state: 'awaiting_delivery', provider_order_id: 'paid-order',
    }), { $set: expect.objectContaining({ status: OrderStatusEnum.ACTIVE, actual_quantity: 1,
      connector_purchase_state: 'delivered', start_date: expect.any(Date), end_date: expect.any(Date) }) }, { session: f.session });
    expect(f.proxies.insertMany).toHaveBeenCalledWith([expect.objectContaining({ connector_delivery_key: expect.any(String),
      ip_address: 'proxy.example.com', auth_password: 'password', order_id: id, is_available: false })], { session: f.session, ordered: true });
    expect(f.session.endSession).toHaveBeenCalled();
  });
  it('keeps empty upstream deliveries pending without any local changes', async () => {
    const f = fixture(); f.runtime.read.mockResolvedValue({ fields: {}, items: [] });
    expect(await f.service.poll(id)).toEqual({ delivered: false });
    expect(f.orders.updateOne).not.toHaveBeenCalled();
    expect(f.proxies.insertMany).not.toHaveBeenCalled();
  });
  it.each([1080, 8080])('delivers dual protocol as one proxy even with SOCKS port %s', async socks5Port => {
    const f = fixture();
    Object.assign(f.order.connector_purchase, { protocolSelection: { mode: 'dual', protocols: ['http', 'socks5'] } });
    f.runtime.read.mockResolvedValue({ fields: {}, items: [{ host: f.proxy.host, httpPort: 8080, socks5Port,
      username: 'user', password: 'password' }] } as any);
    expect(await f.service.poll(id)).toEqual({ delivered: true, quantity: 1 });
    const documents = f.proxies.insertMany.mock.calls[0][0];
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ port: 8080, protocol: 'http', access_endpoints: [
      { protocol: 'http', port: 8080 }, { protocol: 'socks5', port: socks5Port },
    ] });
  });
  it.each(['missing-socks', 'invalid-socks', 'single-result', 'unpinned-dual', 'pinned-single-input'])('rejects unsafe dual delivery %s', async reason => {
    const f = fixture();
    Object.assign(f.order.connector_purchase, { protocolSelection: { mode: 'dual', protocols: ['http', 'socks5'] } });
    const item: any = { host: f.proxy.host, httpPort: 8080, socks5Port: 1080, username: 'user', password: 'password' };
    if (reason === 'missing-socks') delete item.socks5Port;
    if (reason === 'invalid-socks') item.socks5Port = 65536;
    if (reason === 'unpinned-dual') delete (f.order.connector_purchase as any).protocolSelection;
    if (reason === 'pinned-single-input') Object.assign(f.order.connector_purchase.input, { protocol: 'http' });
    f.runtime.read.mockResolvedValue({ fields: {}, items: [reason === 'single-result' ? f.proxy : item] } as any);
    await expect(f.service.poll(id)).rejects.toThrow();
    expect(f.orders.db.startSession).not.toHaveBeenCalled();
  });
  it('records partial deliveries explicitly, without automatic refund or repurchase', async () => {
    const f = fixture(); f.order.quantity = 2;
    await f.service.poll(id);
    expect(f.orders.updateOne.mock.calls[0][1].$set.status).toBe(OrderStatusEnum.PARTIAL);
    expect(f.orders.updateOne.mock.calls[0][1].$set.actual_quantity).toBe(1);
  });
  it('caps the displayed lease at the earliest explicitly mapped upstream expiration', async () => {
    const f = fixture(); f.order.quantity = 2;
    const early = new Date(Date.now() + 86400_000).toISOString();
    f.runtime.read.mockResolvedValue({ fields: {}, items: [
      { ...f.proxy, orderId: 'paid-order', expiresAt: early },
      { ...f.proxy, host: 'second.example.com', expiresAt: new Date(Date.now() + 2 * 86400_000).toISOString() },
    ] } as any);
    await f.service.poll(id);
    expect(f.orders.updateOne.mock.calls[0][1].$set.end_date.toISOString()).toBe(early);
  });
  it.each([
    { orderId: 'different-order' }, { expiresAt: 'not-a-date' }, { expiresAt: '2020-01-01T00:00:00.000Z' },
    { expiresAt: 1800000000 }, { expiresAt: '2027-01-01' },
  ])('rejects mismatched order identity or invalid/expired mapped leases %#', extra => {
    const f = fixture(); f.runtime.read.mockResolvedValue({ fields: {}, items: [{ ...f.proxy, ...extra }] } as any);
    return expect(f.service.poll(id)).rejects.toThrow('Provider delivery');
  });
  it('does not insert after another consumer has fulfilled or changed the order', async () => {
    const f = fixture(); f.orders.updateOne.mockResolvedValue({ modifiedCount: 0 });
    expect(await f.service.poll(id)).toEqual({ delivered: false });
    expect(f.proxies.insertMany).not.toHaveBeenCalled();
  });
  it('requires delivered protocol to match the pinned purchase selection', async () => {
    const f = fixture();
    Object.assign(f.order.connector_purchase.input, { protocol: 'http' });
    f.proxy.protocol = 'socks5';
    await expect(f.service.poll(id)).rejects.toThrow('incompatible');
    expect(f.orders.db.startSession).not.toHaveBeenCalled();
    expect(f.proxies.insertMany).not.toHaveBeenCalled();
  });
  it('accepts matching pinned protocols and guards the quantity and lease snapshot on save', async () => {
    const f = fixture();
    Object.assign(f.order.connector_purchase.input, { protocol: 'http' });
    await expect(f.service.poll(id)).resolves.toEqual({ delivered: true, quantity: 1 });
    expect(f.orders.updateOne.mock.calls[0][0]).toMatchObject({ quantity: 1, duration_days: 30,
      start_date: null, end_date: null });
  });
  it.each(['invalid-start', 'invalid-end', 'expired-end', 'reversed-lease', 'upstream-before-start', 'invalid-pinned-protocol', 'blank-user', 'blank-password', 'control-password'])(
    'refuses unsafe local delivery before opening a transaction: %s', async reason => {
      const f = fixture();
      if (reason === 'invalid-start') (f.order as any).start_date = new Date(NaN);
      if (reason === 'invalid-end') (f.order as any).end_date = new Date(NaN);
      if (reason === 'expired-end') (f.order as any).end_date = new Date(Date.now() - 86400_000);
      if (reason === 'reversed-lease') Object.assign(f.order, { start_date: new Date(Date.now() + 2 * 86400_000),
        end_date: new Date(Date.now() + 86400_000) });
      if (reason === 'upstream-before-start') {
        (f.order as any).start_date = new Date(Date.now() + 2 * 86400_000);
        f.runtime.read.mockResolvedValue({ fields: {}, items: [{ ...f.proxy,
          expiresAt: new Date(Date.now() + 86400_000).toISOString() }] } as any);
      }
      if (reason === 'invalid-pinned-protocol') Object.assign(f.order.connector_purchase.input, { protocol: 'socks4' });
      if (reason === 'blank-user') f.proxy.username = '  ';
      if (reason === 'blank-password') f.proxy.password = '  ';
      if (reason === 'control-password') f.proxy.password = 'sample\npassword';
      await expect(f.service.poll(id)).rejects.toThrow();
      expect(f.orders.db.startSession).not.toHaveBeenCalled();
      expect(f.orders.updateOne).not.toHaveBeenCalled();
      expect(f.proxies.insertMany).not.toHaveBeenCalled();
    });
  it('propagates storage failure inside the transaction and closes the session', async () => {
    const f = fixture(); f.proxies.insertMany.mockRejectedValue(new Error('insert failed'));
    await expect(f.service.poll(id)).rejects.toThrow('insert failed');
    expect(f.session.withTransaction).toHaveBeenCalledTimes(1);
    expect(f.session.endSession).toHaveBeenCalled();
  });
  it.each(['unpaid', 'reconciliation', 'already-active', 'voucher'] )('ignores %s orders before reading upstream', async reason => {
    const f = fixture();
    if (reason === 'unpaid') f.order.payment_status = PaymentStatusEnum.UNPAID;
    if (reason === 'reconciliation') f.order.connector_purchase_state = 'reconciliation';
    if (reason === 'already-active') f.order.status = OrderStatusEnum.ACTIVE;
    if (reason === 'voucher') (f.order as any).voucher_snapshot = {};
    expect(await f.service.poll(id)).toEqual({ delivered: false });
    expect(f.runtime.read).not.toHaveBeenCalled();
  });
  it.each(['excess', 'duplicate', 'unsupported-protocol', 'missing-auth', 'invalid-port'])('refuses %s results without local mutation', async reason => {
    const f = fixture();
    if (reason === 'excess') f.runtime.read.mockResolvedValue({ fields: {}, items: [f.proxy, { ...f.proxy, host: 'other.example.com' }] });
    if (reason === 'duplicate') { f.order.quantity = 2; f.runtime.read.mockResolvedValue({ fields: {}, items: [f.proxy, f.proxy] }); }
    if (reason === 'unsupported-protocol') f.proxy.protocol = 'socks4';
    if (reason === 'missing-auth') f.proxy.password = '';
    if (reason === 'invalid-port') f.proxy.port = 0;
    await expect(f.service.poll(id)).rejects.toThrow();
    expect(f.orders.updateOne).not.toHaveBeenCalled();
    expect(f.proxies.insertMany).not.toHaveBeenCalled();
  });
});
