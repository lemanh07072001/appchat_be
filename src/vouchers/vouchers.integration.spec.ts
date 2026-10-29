import { Connection, createConnection, Types } from 'mongoose';
import { VouchersService } from './vouchers.service';
import { User, UserSchema } from '../schemas/users.schema';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { Service, ServiceSchema } from '../schemas/services.schema';
import { Proxy, ProxySchema } from '../schemas/proxies.schema';
import { OrderStatusEnum as OS, PaymentMethodEnum, PaymentStatusEnum } from '../enum/order.enum';
import { OrdersWorkerService } from '../orders/orders.worker.service';
import { OrdersService } from '../orders/orders.service';
import { OrdersExpirationScheduler } from '../orders/orders-expiration.scheduler';
import { AffiliateService } from '../affiliate/affiliate.service';
import { AffiliateCommission, AffiliateCommissionSchema } from '../schemas/affiliate-commission.schema';
import { AffiliateConfig, AffiliateConfigSchema } from '../schemas/affiliate-config.schema';

jest.mock('../common/commerce-policy', () => ({ assertCommerceEnabled: jest.fn() }));

// Opt-in only. Never uses the application database or changes deployment setup.
const uri = process.env.VOUCHER_TEST_MONGO_URI;
(uri ? describe : describe.skip)('Voucher saga on disposable standalone Mongo', () => {
  let db: Connection, users: any, orders: any, services: any, proxies: any, sut: VouchersService;
  let affiliate: AffiliateService, commissions: any, configs: any;
  const redis = { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), lpush: jest.fn(async () => 1), eval: jest.fn(async () => 1), exists: jest.fn(async () => 1) };
  beforeAll(async () => {
    db = await createConnection(uri!, { dbName: `voucher_test_${new Types.ObjectId()}`, serverSelectionTimeoutMS: 5000 }).asPromise();
    users = db.model(User.name, UserSchema); orders = db.model(Order.name, OrderSchema);
    services = db.model(Service.name, ServiceSchema); proxies = db.model(Proxy.name, ProxySchema);
    await Promise.all([users.init(), orders.init(), services.init(), proxies.init()]);
    commissions = db.model(AffiliateCommission.name, AffiliateCommissionSchema);
    configs = db.model(AffiliateConfig.name, AffiliateConfigSchema);
    await Promise.all([commissions.init(), configs.init()]);
    affiliate = new AffiliateService(commissions, configs, users, {} as any);
    sut = new VouchersService(db, orders, users, services, redis as any, proxies, affiliate);
    await sut.onModuleInit();
  });
  afterAll(async () => { if (db) { await db.dropDatabase(); await db.close(); } });
  afterEach(() => jest.restoreAllMocks());
  async function fixture(limits: any = {}) {
    const userId = new Types.ObjectId(), serviceId = new Types.ObjectId();
    await users.collection.insertOne({ _id: userId, name: 'Test', email: `${userId}@example.test`, password: 'unused', money: 10000,
      topup_code: userId.toString(), referral_code: userId.toString(), voucher_receipts: [] });
    await services.collection.insertOne({ _id: serviceId, name: 'Test product', status: true, api_enabled: true });
    const v = await sut.write({ code: `V${new Types.ObjectId()}`, name: 'Test voucher', status: 'active', startsAt: '2020-01-01', endsAt: '2099-01-01', discountType: 'fixed', discountValue: 299,
      maxDiscount: 9999, minSubtotal: 0, scope: 'all', serviceIds: [], totalLimit: 10, perUserLimit: 10, ...limits }, 'actor');
    const dto = { service_id: serviceId.toString(), duration_days: 30, quantity: 3, voucher_code: v.code };
    const snapshot = { order_code: `TEST-${new Types.ObjectId()}`, user_id: userId, service_id: serviceId, partner_id: new Types.ObjectId(), quantity: 3,
      duration_days: 30, price_per_unit: 334, total_price: 1000, payment_method: PaymentMethodEnum.BALANCE, payment_status: PaymentStatusEnum.PAID, status: OS.PENDING,
      start_date: new Date(), end_date: null, config: {} };
    const buy = (key = new Types.ObjectId().toString(), payload = dto) => sut.purchase(userId.toString(), key, payload, { ...snapshot, order_code: `TEST-${new Types.ObjectId()}` }, 'Test product');
    return { userId, serviceId, v, dto, snapshot, buy };
  }
  it('admits only one concurrent last-use and no quota leak', async () => {
    const f = await fixture({ totalLimit: 1 });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => f.buy()));
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((await users.findById(f.userId)).money).toBe(9299);
    const v = await sut.vouchers.findOne({ _id: f.v._id });
    expect(v.reserved).toBe(1); expect(v.used).toBe(0);
    expect(v.reservations.filter((r: any) => r.status === 'reserved')).toHaveLength(1);
  });
  it('reserves per-user quota in the same document as total capacity', async () => {
    const f = await fixture({ perUserLimit: 1 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => f.buy()));
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((await sut.vouchers.findOne({ _id: f.v._id })).reserved).toBe(1);
  });
  it('replays same key concurrently once, rejects different payloads', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 10 }, () => f.buy('same')));
    expect(new Set(results.map(x => x.data.order_id)).size).toBe(1);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(1);
    expect((await users.findById(f.userId)).money).toBe(9299);
    await expect(f.buy('same', { ...f.dto, quantity: 4 })).rejects.toThrow('payload mismatch');
    expect(results[0].data.balance_before).toBe(10000);
  });
  it('recovers debit before order insert and lost queue with Redis down', async () => {
    const f = await fixture();
    const fail = jest.spyOn(orders.prototype, 'save').mockRejectedValueOnce(new Error('insert outage'));
    await expect(f.buy('recover')).rejects.toThrow('insert outage');
    fail.mockRestore();
    expect((await users.findById(f.userId)).money).toBe(9299);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(0);
    redis.lpush.mockRejectedValueOnce(new Error('queue down') as never);
    const result = await f.buy('recover');
    expect(result.data.balance_before).toBe(10000);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(1);
    const pushes = redis.lpush.mock.calls.length;
    await sut.reconcile();
    expect(redis.lpush.mock.calls.length).toBeGreaterThan(pushes);
    expect((await users.findById(f.userId)).money).toBe(9299);
  });
  it('recovers receipt when debit succeeded but updating intent failed', async () => {
    const f = await fixture();
    const original = sut.intents.updateOne.bind(sut.intents);
    const spy = jest.spyOn(sut.intents, 'updateOne').mockImplementation(async (...args: any[]) => {
      if (args[1]?.$set?.balance_before === 10000) throw new Error('intent outage');
      return original(...args);
    });
    await expect(f.buy('receipt')).rejects.toThrow('intent outage');
    spy.mockRestore();
    await f.buy('receipt');
    expect((await users.findById(f.userId)).money).toBe(9299);
    expect((await users.collection.findOne({ _id: f.userId })).voucher_receipts).toHaveLength(1);
  });
  it('recovers reservation before intent transition without losing either quota', async () => {
    const f = await fixture({ perUserLimit: 1, totalLimit: 1 });
    const original = sut.intents.updateOne.bind(sut.intents);
    const spy = jest.spyOn(sut.intents, 'updateOne').mockImplementation(async (...args: any[]) => {
      if (args[1]?.$set?.state === 'reserved') throw new Error('reservation transition outage');
      return original(...args);
    });
    await expect(f.buy('reserve-recovery')).rejects.toThrow('transition outage');
    spy.mockRestore();
    expect((await sut.vouchers.findOne({ _id: f.v._id })).reserved).toBe(1);
    await sut.reconcile();
    expect((await users.findById(f.userId)).money).toBe(9299);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(1);
    expect((await sut.vouchers.findOne({ _id: f.v._id })).reserved).toBe(1);
  });
  it('insufficient-funds rejection fences delayed retries and releases quota', async () => {
    const f = await fixture({ totalLimit: 1, perUserLimit: 1 });
    await users.updateOne({ _id: f.userId }, { $set: { money: 0 } });
    await Promise.allSettled(Array.from({ length: 10 }, () => f.buy('no-funds')));
    await users.updateOne({ _id: f.userId }, { $set: { money: 10000 } });
    await expect(f.buy('no-funds')).rejects.toThrow('Insufficient balance');
    expect((await sut.vouchers.findOne({ _id: f.v._id })).reserved).toBe(0);
    await f.buy('fresh-key');
    expect((await users.findById(f.userId)).money).toBe(9299);
  });
  it('OrdersService buy/quote apply voucher AFTER user pricing and require key', async () => {
    const f = await fixture();
    await services.updateOne({ _id: f.serviceId }, { $set: { pricing: { '30': { price: 500 } }, partner: f.snapshot.partner_id,
      user_discounts: { [f.userId.toString()]: { '30': 100 } } } });
    const host = new OrdersService(orders, users, services, {} as any, proxies,
      { findById: () => ({ exec: async () => ({ status: true, code: 'test', token_api: 'test-key' }) }) } as any,
      redis as any, {} as any, {} as any, {} as any,
      { getProvider: () => ({}) } as any, sut, { select: async () => undefined } as any);
    const quote = await host.quote(f.userId.toString(), f.dto);
    expect(quote.subtotal).toBe(1200); expect(quote.total_price).toBe(901);
    await expect(host.buy(f.userId.toString(), f.dto)).rejects.toThrow('Idempotency-Key');
    const result = await host.buy(f.userId.toString(), f.dto, 'orders-route');
    expect(result.data.total_price).toBe(901);
    expect(result.data).not.toHaveProperty('partner_id'); expect(result.data).not.toHaveProperty('total_cost');
    await host.buy(f.userId.toString(), f.dto, 'orders-route');
    expect((await users.findById(f.userId)).money).toBe(9099);
    await expect(host.buy(f.userId.toString(), { ...f.dto, voucher_code: undefined }, 'orders-route')).rejects.toThrow('payload mismatch');
  });
  it('rejects expired/edited codes even when quote cache is stale', async () => {
    const f = await fixture();
    redis.get.mockResolvedValueOnce(JSON.stringify(f.v) as never);
    expect((await sut.quote(f.v.code, f.dto.service_id, 1000)).total_price).toBe(701);
    await sut.write({ ...f.v, status: 'paused' }, 'editor', f.v._id.toString());
    await expect(f.buy()).rejects.toThrow('not applicable');
    await sut.write({ ...f.v, endsAt: '2021-01-01' }, 'editor', f.v._id.toString());
    await expect(f.buy()).rejects.toThrow('not applicable');
    const audit = await sut.audit({ voucherId: f.v._id.toString() });
    expect(audit.total).toBe(3); expect(audit.data.some((x: any) => x.actor === 'editor' && x.before)).toBe(true);
  });
  it('database quote fallback is limited when Redis is down', async () => {
    const user = new Types.ObjectId().toString();
    const spy = jest.spyOn(redis, 'eval').mockRejectedValue(new Error('redis down') as never);
    for (let i = 0; i < 5; i++) await sut.rateLimit(user);
    await expect(sut.rateLimit(user)).rejects.toMatchObject({ status: 429 });
    spy.mockRestore();
  });
  it('exposes filtered usage pagination, CSV and cached statistics without purchase secrets', async () => {
    const f = await fixture(); await f.buy('report');
    const page = await sut.usages({ code: f.v.code, userId: f.userId.toString(), serviceId: f.dto.service_id, status: 'reserved', page: 1, limit: 5 });
    expect(page).toMatchObject({ total: 1, page: 1, limit: 5 });
    expect(page.data[0]).not.toHaveProperty('key'); expect(page.data[0].order).not.toHaveProperty('config');
    expect((await sut.usages({ code: f.v.code, status: 'released' })).total).toBe(0);
    expect(await sut.export({ code: f.v.code })).toContain(f.v.code);
    expect((await sut.stats()).data.some((x: any) => x._id === 'reserved')).toBe(true);
    expect((await sut.list({ search: f.v.code })).data[0]).not.toHaveProperty('reservations');
  });
  it('idempotently materializes duplicate fulfilment and refunds missing NET allocation once', async () => {
    const f = await fixture(); const result = await f.buy(); const id = result.data.order_id;
    const provider = { proxies: [{ host: '127.0.0.1', port: 1234, username: 'a', password: 'b' }], provider_order_id: 'provider' };
    await Promise.all(Array.from({ length: 8 }, () => sut.materialize(id, provider, 'test')));
    expect((await orders.findById(id).select('+voucher_fulfilment')).voucher_resolution).toBe('fulfilled');
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(id) })).toBe(1);
    let o = await orders.findById(id);
    expect(o.status).toBe(OS.PARTIAL);
    expect((await sut.vouchers.findOne({ _id: f.v._id })).used).toBe(1);
    await Promise.all(Array.from({ length: 8 }, () => sut.refund(o, undefined, 'admin', true)));
    expect((await users.findById(f.userId)).money).toBe(9766); // 10000 -701 + floor(701*2/3)
    o = await orders.findById(id);
    expect(o.refunded_amount).toBe(467); expect(o.status).toBe(OS.PARTIAL_REFUNDED);
    expect((await sut.vouchers.findOne({ _id: f.v._id })).used).toBe(1);
    await sut.reconcile();
    expect((await orders.findById(id)).status).toBe(OS.PARTIAL_REFUNDED);
    expect(await db.collection('wallettransactions').countDocuments({ ref_id: id })).toBe(2);
  });
  it('recovers saved provider response and interrupted proxy materialization', async () => {
    const f = await fixture(); const result = await f.buy(); const id = result.data.order_id;
    await orders.updateOne({ _id: id }, { $set: { voucher_dispatch_claimed: true, voucher_provider_result_partner: 'test', voucher_provider_result: {
      provider_order_id: 'saved-result', proxies: [{ host: '127.0.0.3', port: 1234, username: 'a', password: 'b' }],
    } } });
    const spy = jest.spyOn(proxies, 'updateOne').mockImplementationOnce(() => { throw new Error('proxy outage'); });
    await sut.reconcile(); spy.mockRestore();
    expect((await orders.findById(id)).voucher_resolution).toBe('fulfilled');
    await sut.reconcile();
    expect((await orders.findById(id)).status).toBe(OS.PARTIAL);
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(id) })).toBe(1);
    expect((await users.findById(f.userId)).money).toBe(9299);
  });
  it('retains unknown reservations; confirmed full-failure refund releases exactly once', async () => {
    const f = await fixture(); const result = await f.buy(); const id = result.data.order_id;
    await orders.updateOne({ _id: id }, { $set: { status: OS.PENDING_REFUND } });
    let o = await orders.findById(id);
    await expect(sut.refund(o, undefined, 'admin')).rejects.toThrow('Confirm full provider failure');
    expect((await sut.vouchers.findOne({ _id: f.v._id })).reserved).toBe(1);
    o = await sut.confirmFailure(id, 'operator', 'Provider confirmed cancellation ticket 123');
    await Promise.all(Array.from({ length: 8 }, () => sut.refund(o, undefined, 'operator')));
    expect((await users.findById(f.userId)).money).toBe(10000);
    const v = await sut.vouchers.findOne({ _id: f.v._id }); expect(v.reserved).toBe(0); expect(v.used).toBe(0);
    await sut.materialize(id, { proxies: [{ host: '127.0.0.2', port: 1234 }] }, 'test');
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(id) })).toBe(0);
  });
  it('recovers refund after receipt credit and before order finalization', async () => {
    const f = await fixture(); const result = await f.buy(); const id = result.data.order_id;
    await orders.updateOne({ _id: id }, { $set: { status: OS.PENDING_REFUND } });
    const o = await sut.confirmFailure(id, 'operator', 'Provider confirmed no purchase took place');
    const spy = jest.spyOn(orders, 'updateOne').mockImplementationOnce(() => { throw new Error('refund finalize outage'); });
    await expect(sut.refund(o, undefined, 'operator')).rejects.toThrow('refund finalize outage');
    spy.mockRestore();
    await sut.reconcile();
    expect((await users.findById(f.userId)).money).toBe(10000);
    expect((await orders.findById(id)).refunded_amount).toBe(701);
  });
  it('serializes provider fulfilment racing explicit full-failure resolution', async () => {
    const f = await fixture(); const result = await f.buy(); const id = result.data.order_id;
    await orders.updateOne({ _id: id }, { $set: { status: OS.PENDING_REFUND } });
    await Promise.allSettled([
      sut.materialize(id, { proxies: [{ host: '127.0.0.8', port: 1234, username: 'a', password: 'b' }] }, 'test'),
      sut.confirmFailure(id, 'operator', 'Provider cancellation confirmed by support'),
    ]);
    const o = await orders.findById(id);
    if (o.voucher_resolution === 'failed') {
      await sut.refund(o, undefined, 'operator');
      expect(await proxies.countDocuments({ order_id: new Types.ObjectId(id) })).toBe(0);
      expect((await users.findById(f.userId)).money).toBe(10000);
    } else {
      expect(o.status).toBe(OS.PARTIAL);
      await expect(sut.refund(o, undefined, 'operator')).rejects.toThrow('Confirm full provider failure');
      expect((await users.findById(f.userId)).money).toBe(9299);
    }
  });
  it('Mongo dispatch fence survives duplicate deliveries and provider throws without retry', async () => {
    const f = await fixture(); const result = await f.buy(); const id = result.data.order_id;
    const provider = { buy: jest.fn(async () => { throw new Error('ambiguous network timeout'); }) };
    const partnerModel = { findById: () => ({ exec: async () => ({ _id: f.snapshot.partner_id, code: 'test', token_api: 'unused' }) }) };
    const r = { ...redis, incr: async () => 1, expire: async () => 1 };
    const logs = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const worker = new OrdersWorkerService(orders, partnerModel as any, services, proxies, r as any, r as any, { getProvider: () => provider } as any, {} as any, logs as any, { sendOrderFailed: jest.fn() } as any, sut);
    await Promise.all(Array.from({ length: 5 }, () => (worker as any).processOrder(id)));
    await (worker as any).processOrder(id);
    expect(provider.buy).toHaveBeenCalledTimes(1);
    expect((await sut.vouchers.findOne({ _id: f.v._id })).reserved).toBe(1);
  });
  it('reconciliation takes the worker dispatch fence before fetching, including empty/retried fetches', async () => {
    const f = await fixture(); const result = await f.buy(); const id = result.data.order_id;
    let entered!: () => void, finish!: (p: any[]) => void;
    const fetching = new Promise<void>(r => { entered = r; });
    const provider = { buy: jest.fn(), fetchOrderProxies: jest.fn(() => { entered(); return new Promise<any[]>(r => { finish = r; }); }) };
    const partner = { _id: f.snapshot.partner_id, code: 'test', token_api: 'unused' };
    const partners = { findById: () => ({ select: () => ({ exec: async () => partner }), exec: async () => partner }) };
    const factory = { getProvider: () => provider };
    const logs = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const host = new OrdersService(orders, users, services, {} as any, proxies, partners as any, redis as any, logs as any, {} as any, {} as any, factory as any, sut, { select: async () => undefined } as any);
    const worker = new OrdersWorkerService(orders, partners as any, services, proxies, redis as any, redis as any, factory as any, affiliate, logs as any, {} as any, sut);
    const syncing = host.syncProviderOrder(id, 'manual-provider-id', 'operator');
    await fetching;
    await (worker as any).processOrder(id);
    expect(provider.buy).not.toHaveBeenCalled();
    expect((await orders.findById(id)).voucher_dispatch_source).toBe('reconciliation');
    finish([]); await syncing;
    await sut.reconcile();
    expect((await orders.findById(id)).provider_order_id).toBe('manual-provider-id');
    // A worker that wins first prevents manual fetching while buy is still pending.
    const g = await fixture(); const second = await g.buy();
    await orders.updateOne({ _id: second.data.order_id }, { $set: { voucher_dispatch_claimed: true, voucher_dispatch_source: 'worker' } });
    await expect(host.syncProviderOrder(second.data.order_id, 'other', 'operator')).rejects.toThrow('in flight');
    await orders.updateOne({ _id: second.data.order_id }, { $set: { status: OS.PENDING_REFUND } });
    await expect(host.syncProviderOrder(second.data.order_id, 'other', 'operator')).rejects.toThrow('in flight');
    expect(provider.fetchOrderProxies).toHaveBeenCalledTimes(1);
    await orders.updateOne({ _id: second.data.order_id }, { $set: { status: OS.PENDING, voucher_dispatch_claimed: false, voucher_resolution: 'failed' } });
    await (worker as any).processOrder(second.data.order_id);
    expect(provider.buy).not.toHaveBeenCalled();
  });
  it('does not expire unresolved PROCESSING vouchers or infer usage from legacy EXPIRED status', async () => {
    const f = await fixture(); const result = await f.buy(); const id = result.data.order_id;
    await orders.updateOne({ _id: id }, { $set: { status: OS.PROCESSING, end_date: new Date(0), provider_order_id: 'async-id', voucher_dispatch_claimed: true } });
    const scheduler = new OrdersExpirationScheduler(orders, proxies, affiliate, { info: jest.fn() } as any);
    await scheduler.checkExpiredOrders();
    expect((await orders.findById(id)).status).toBe(OS.PROCESSING);
    await orders.updateOne({ _id: id }, { $set: { status: OS.EXPIRED } });
    await sut.settle(await orders.findById(id));
    expect((await sut.vouchers.findOne({ _id: f.v._id })).reserved).toBe(1);
    expect((await sut.vouchers.findOne({ _id: f.v._id })).used).toBe(0);
    // Also repair the old settle implementation's incorrect EXPIRED consumption.
    await sut.vouchers.updateOne({ _id: f.v._id, 'reservations.token': (await orders.findById(id)).voucher_snapshot.intentId }, {
      $inc: { reserved: -1, used: 1 }, $set: { 'reservations.$.status': 'used' },
    });
    await sut.intents.updateOne({ 'order._id': new Types.ObjectId(id) }, { $set: { status: 'used' } });
    await sut.reconcile();
    expect((await orders.findById(id)).status).toBe(OS.PENDING_REFUND);
    expect((await sut.vouchers.findOne({ _id: f.v._id })).reserved).toBe(1);
    expect((await sut.vouchers.findOne({ _id: f.v._id })).used).toBe(0);
    await sut.materialize(id, { proxies: [{ host: '127.0.0.9', port: 1234, username: 'a', password: 'b' }] }, 'test');
    expect((await orders.findById(id)).status).toBe(OS.PARTIAL);
    expect((await sut.vouchers.findOne({ _id: f.v._id })).used).toBe(1);
  });
  it('recovers affiliate commission after ACTIVE hook failure and concurrent replay without double credit', async () => {
    const f = await fixture(); const referrer = new Types.ObjectId();
    await users.collection.insertOne({ _id: referrer, email: `${referrer}@example.test`, topup_code: `${referrer}`, referral_code: `${referrer}`, commission_rate: 10, affiliate_balance: 0 });
    await users.updateOne({ _id: f.userId }, { $set: { referred_by: referrer } });
    jest.spyOn(affiliate, 'getConfig').mockResolvedValue({ is_active: true, commission_rate: 10 } as any);
    const result = await f.buy(); const id = result.data.order_id;
    const response = { proxies: [1,2,3].map(n => ({ host: `127.0.1.${n}`, port: 1234, username: 'a', password: 'b' })) };
    const fail = jest.spyOn(commissions.prototype, 'save').mockRejectedValueOnce(new Error('affiliate outage'));
    await expect(sut.materialize(id, response, 'test')).rejects.toThrow('affiliate outage');
    fail.mockRestore();
    expect((await orders.findById(id)).status).toBe(OS.ACTIVE);
    expect((await orders.findById(id)).voucher_affiliate_pending).toBe(true);
    await orders.updateOne({ _id: id }, { $set: { end_date: new Date(0) } });
    const scheduler = new OrdersExpirationScheduler(orders, proxies, affiliate, { info: jest.fn() } as any);
    await scheduler.checkExpiredOrders();
    expect((await orders.findById(id)).status).toBe(OS.ACTIVE);
    await sut.reconcile();
    // Simulate a crash after commission insert but before clearing the order outbox.
    await orders.updateOne({ _id: id }, { $set: { voucher_affiliate_pending: true } });
    await Promise.all(Array.from({ length: 8 }, () => sut.materialize(id, response, 'test')));
    expect(await commissions.countDocuments({ order_id: new Types.ObjectId(id) })).toBe(1);
    const commission = await commissions.findOne({ order_id: new Types.ObjectId(id) });
    expect(commission.commission_amount).toBe(70.1); expect(commission.order_total).toBe(701);
    expect((await users.findById(referrer)).affiliate_balance).toBe(0);
    expect((await orders.findById(id)).voucher_affiliate_pending).toBe(false);
    await scheduler.checkExpiredOrders();
    expect((await orders.findById(id)).status).toBe(OS.EXPIRED);
    await affiliate.handleOrderExpired([new Types.ObjectId(id)], true);
    expect((await commissions.findOne({ order_id: new Types.ObjectId(id) })).status).toBe('confirmed');
  });
  it('retains failure actor/evidence/time atomically and repairs audit projection after outage', async () => {
    const f = await fixture(); const result = await f.buy(); const id = result.data.order_id;
    await orders.updateOne({ _id: id }, { $set: { status: OS.PENDING_REFUND } });
    const original = sut.intents.updateOne.bind(sut.intents);
    const failure = jest.spyOn(sut.intents, 'updateOne').mockImplementation(async (...args: any[]) => {
      if (args[1]?.$set?.failureConfirmation) throw new Error('audit projection outage');
      return original(...args);
    });
    const evidence = 'Provider confirmed cancellation support ticket 567';
    await expect(sut.confirmFailure(id, 'operator', evidence)).rejects.toThrow('audit projection outage');
    failure.mockRestore();
    const o = await orders.findById(id);
    expect(o.voucher_resolution).toBe('failed');
    expect(o.voucher_failure_confirmation).toMatchObject({ actor: 'operator', evidence, at: expect.any(Date) });
    await sut.reconcile();
    await Promise.all(Array.from({ length: 5 }, () => sut.confirmFailure(id, 'operator', evidence)));
    const i = await sut.intents.findOne({ _id: new Types.ObjectId(o.voucher_snapshot.intentId) });
    expect(i.failureConfirmation).toEqual(o.voucher_failure_confirmation);
    expect(i.events.filter((e: any) => e.type === 'provider_failure_confirmed')).toHaveLength(1);
    await expect(sut.confirmFailure(id, 'different-operator', 'Changed evidence must not replace original')).rejects.toThrow();
  });
});
