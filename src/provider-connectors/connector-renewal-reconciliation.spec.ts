import { ConnectorRenewalReconciliation } from './connector-renewal-reconciliation.service';

describe('Connector renewal reconciliation', () => {
  const id = '507f1f77bcf86cd799439011';
  const user = '507f1f77bcf86cd799439022';
  const previousEndDate = new Date('2026-11-01T03:45:19.000Z');
  const review = { evidence: 'Đã đối chiếu trên trang nhà cung cấp lúc 14:05', actor: 'admin-1' };

  function fixture() {
    const sent = { accountId: id, connectorCode: 'homeproxy_static_http_candidate', connectorVersion: 5,
      input: { providerProxyIds: [1683054, 1683055], durationDays: 7 }, price: 19800, previousEndDate };
    const order = { _id: id, order_code: 'ORD-1', user_id: user, service_id: id, connector_renewal: sent,
      connector_renewal_state: 'reconciliation', connector_renewal_key: 'renew-key-hash',
      end_date: previousEndDate, renew_count: 1, updatedAt: new Date('2026-10-30T07:00:00.000Z') };
    const query = (value: unknown) => ({ select: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(value) });
    const session = { withTransaction: jest.fn(async (callback: () => Promise<void>) => callback()), endSession: jest.fn() };
    const orders = { find: jest.fn(() => query([order])), findById: jest.fn(() => query(order)),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      db: { startSession: jest.fn().mockResolvedValue(session) } };
    const services = { find: jest.fn(() => query([{ _id: id, name: 'HomeProxy VIETTEL' }])) };
    const users = { find: jest.fn(() => query([{ _id: user, email: 'khach@example.com' }])),
      findOneAndUpdate: jest.fn((_filter: unknown, _update?: unknown) => query({ money: 50000 })) };
    const wallet = { create: jest.fn() };
    const dispatches = { find: jest.fn(() => query([{ orderId: id, reference: 'renew:abc', status: 'unknown',
      submittedAt: new Date('2026-10-30T06:59:00.000Z'), completedAt: undefined }])) };
    const sut = new ConnectorRenewalReconciliation(orders as never, services as never, users as never,
      wallet as never, dispatches as never);
    return { sut, order, orders, services, users, wallet, dispatches, session };
  }

  it('lists a stuck renewal with the money, the proxies and the dispatch behind it', async () => {
    const f = fixture();
    const list = await f.sut.pending();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ order_code: 'ORD-1', price: 19800, duration_days: 7,
      provider_proxy_ids: [1683054, 1683055], service: 'HomeProxy VIETTEL',
      connector: 'homeproxy_static_http_candidate v5',
      user: { id: user, email: 'khach@example.com' },
      dispatch: { reference: 'renew:abc', status: 'unknown' } });
    expect(list.items[0].previous_end_date).toEqual(previousEndDate);
  });

  it('asks nothing else when no renewal is stuck', async () => {
    const f = fixture();
    f.orders.find = jest.fn(() => ({ select: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]) })) as never;
    expect(await f.sut.pending()).toEqual({ total: 0, items: [] });
    expect(f.users.find).not.toHaveBeenCalled();
    expect(f.dispatches.find).not.toHaveBeenCalled();
  });

  it('extends from the old expiry without charging or refunding when upstream did renew', async () => {
    const f = fixture();
    const result = await f.sut.resolve(id, { ...review, outcome: 'extended' });
    const update = f.orders.updateOne.mock.calls[0];
    expect(update[0]).toMatchObject({ connector_renewal_state: 'reconciliation', end_date: previousEndDate });
    expect(update[1].$set.end_date.getTime()).toBe(previousEndDate.getTime() + 7 * 86400_000);
    expect(update[1].$set.connector_renewal_state).toBeNull();
    expect(update[1].$set.connector_renewal_review).toMatchObject({ outcome: 'extended', actor: 'admin-1', price: 19800 });
    expect(update[1].$inc).toEqual({ renew_count: 1 });
    expect(f.wallet.create).not.toHaveBeenCalled();
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'extended', refunded: 0 });
  });

  it('refuses to extend an order whose expiry moved under it', async () => {
    const f = fixture();
    f.orders.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 0 }) as never;
    await expect(f.sut.resolve(id, { ...review, outcome: 'extended' })).rejects.toThrow('vừa thay đổi');
    expect(f.wallet.create).not.toHaveBeenCalled();
  });

  it('refunds exactly what was debited, once, and leaves the expiry alone', async () => {
    const f = fixture();
    const result = await f.sut.resolve(id, { ...review, outcome: 'not-extended' });
    const update = f.orders.updateOne.mock.calls[0];
    expect(update[1].$set).not.toHaveProperty('end_date');
    expect(update[1].$set.connector_renewal_state).toBeNull();
    expect(f.users.findOneAndUpdate.mock.calls[0][1]).toEqual({ $inc: { money: 19800 } });
    expect(f.wallet.create.mock.calls[0][0][0]).toMatchObject({ type: 'refund', direction: 'in', amount: 19800,
      credit_key: 'connector-renewal-refund:renew-key-hash', balance_before: 30200, balance_after: 50000 });
    expect(result).toMatchObject({ outcome: 'not-extended', refunded: 19800 });
  });

  it('does not refund twice when the renewal was already resolved', async () => {
    const f = fixture();
    f.orders.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 0 }) as never;
    await expect(f.sut.resolve(id, { ...review, outcome: 'not-extended' })).rejects.toThrow('vừa thay đổi');
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.wallet.create).not.toHaveBeenCalled();
  });

  it.each(['', 'ngắn quá', 'x'.repeat(501)])('refuses a resolution without usable evidence (%s)', async evidence => {
    const f = fixture();
    await expect(f.sut.resolve(id, { outcome: 'extended', evidence, actor: 'admin-1' })).rejects.toThrow('Bằng chứng');
    expect(f.orders.updateOne).not.toHaveBeenCalled();
  });

  it.each(['no-renewal', 'not-stuck', 'no-key'])('refuses an order that has nothing to reconcile (%s)', async reason => {
    const f = fixture();
    if (reason === 'no-renewal') (f.order as { connector_renewal: unknown }).connector_renewal = null;
    if (reason === 'not-stuck') (f.order as { connector_renewal_state: unknown }).connector_renewal_state = null;
    if (reason === 'no-key') (f.order as { connector_renewal_key?: string }).connector_renewal_key = undefined;
    await expect(f.sut.resolve(id, { ...review, outcome: 'extended' })).rejects.toThrow();
    expect(f.orders.updateOne).not.toHaveBeenCalled();
    expect(f.wallet.create).not.toHaveBeenCalled();
  });
});
