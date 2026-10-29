import { Connection, createConnection, Types } from 'mongoose';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { Service, ServiceSchema } from '../schemas/services.schema';
import { Proxy, ProxySchema } from '../schemas/proxies.schema';
import { WalletTransaction, WalletTransactionSchema } from '../schemas/wallet-transaction.schema';
import { ConnectorCheckout } from './connector-checkout.service';
import { ConnectorOrderDelivery } from './connector-order-delivery.service';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';
import { AffiliateCommission, AffiliateCommissionSchema } from '../schemas/affiliate-commission.schema';
import { AffiliateConfig, AffiliateConfigSchema } from '../schemas/affiliate-config.schema';
import { AffiliateService } from '../affiliate/affiliate.service';
import { ConnectorFulfillmentEffects } from '../orders/connector-fulfillment-effects.service';
import { Partner, PartnerSchema } from '../schemas/partners.schema';
import { ConnectorAccount, ConnectorAccountSchema } from './connector-account.schema';
import { ConnectorCredentialMigration } from './connector-credential-migration.service';
import { ConnectorSecrets } from './connector-secrets.service';
import { ConnectorDispatch, ConnectorDispatchSchema } from './connector-dispatch.schema';
import { ConnectorDispatches } from './connector-dispatch.service';
import { ConnectorOrderPurchase } from './connector-order-purchase.service';
import { homeproxyPurchaseCandidate } from './homeproxy-template';

// Opt-in replica set only. Always creates its own database; never uses fastproxy.
const uri = process.env.CONNECTOR_TEST_MONGO_URI;
(uri ? describe : describe.skip)('Connector commerce on disposable Mongo replica set', () => {
  let db: Connection, orders: any, users: any, services: any, proxies: any, wallet: any;
  let checkout: ConnectorCheckout;
  let commissions: any, configs: any, effects: ConnectorFulfillmentEffects;
  let partners: any, accounts: any, migration: ConnectorCredentialMigration, secrets: ConnectorSecrets;
  let dispatchModel: any;
  beforeAll(async () => {
    db = await createConnection(uri!, { dbName: `connector_test_${new Types.ObjectId()}`, serverSelectionTimeoutMS: 5000 }).asPromise();
    orders = db.model(Order.name, OrderSchema); users = db.model(User.name, UserSchema);
    services = db.model(Service.name, ServiceSchema); proxies = db.model(Proxy.name, ProxySchema);
    wallet = db.model(WalletTransaction.name, WalletTransactionSchema);
    partners = db.model(Partner.name, PartnerSchema); accounts = db.model(ConnectorAccount.name, ConnectorAccountSchema);
    dispatchModel = db.model(ConnectorDispatch.name, ConnectorDispatchSchema);
    await Promise.all([partners.init(), accounts.init(), dispatchModel.init()]);
    secrets = new ConnectorSecrets({ get: () => 'ab'.repeat(32) } as any);
    migration = new ConnectorCredentialMigration(partners, accounts,
      { publishedDefinition: async () => ({ baseUrl: 'https://api.example.com/api' }) } as any, secrets);
    commissions = db.model(AffiliateCommission.name, AffiliateCommissionSchema);
    configs = db.model(AffiliateConfig.name, AffiliateConfigSchema);
    await Promise.all([commissions.init(), configs.init()]);
    effects = new ConnectorFulfillmentEffects(orders, new AffiliateService(commissions, configs, users, {} as any));
    await Promise.all([orders.init(), users.init(), services.init(), proxies.init(), wallet.init()]);
    checkout = new ConnectorCheckout(orders, users, services, wallet, { get: () => 'true' } as any);
  });
  afterAll(async () => {
    if (db) { await db.dropDatabase(); await db.close(); }
  });
  afterEach(() => jest.restoreAllMocks());
  async function fixture() {
    const userId = new Types.ObjectId(), serviceId = new Types.ObjectId(), accountId = new Types.ObjectId();
    await users.collection.insertOne({ _id: userId, money: 1000, email: `${userId}@example.test`,
      topup_code: String(userId), referral_code: String(userId) });
    const binding = { accountId: String(accountId), connectorCode: 'example', connectorVersion: 1, packages: { '30': 'p1' } };
    const service = await services.create({ _id: serviceId, name: 'Test product', status: true, api_enabled: true,
      pricing_mode: 'duration', pricing: { '30': { price: 100 } }, connector_binding: binding });
    const payload = { service_id: String(serviceId), duration_days: 30, quantity: 1 };
    const request = { userId: String(userId), key: `key-${userId}`, payload, service: service.toObject(),
      order: { order_code: `TEST-${new Types.ObjectId()}`, quantity: 1, duration_days: 30, pricing_mode: 'duration',
        price_per_unit: 100, total_price: 100, connector_purchase: { accountId: String(accountId),
          connectorCode: 'example', connectorVersion: 1, input: { packageId: 'p1', quantity: 1, durationDays: 30, protocol: 'http' } } } };
    return { request, userId, serviceId };
  }
  it('concurrent credential copies create one disabled encrypted account and preserve legacy data', async () => {
    const partner = await partners.create({ name: 'Migration provider', code: `test-${new Types.ObjectId()}`, token_api: 'source-key' });
    const body = { connectorCode: 'example', connectorVersion: 1, expectedOrigin: 'https://api.example.com' };
    const results = await Promise.all(Array.from({ length: 6 }, () => migration.copy(String(partner._id), body)));
    expect(new Set(results.map(row => row.accountId)).size).toBe(1);
    expect(await accounts.countDocuments({ legacyPartnerId: partner._id })).toBe(1);
    const account = await accounts.findById(results[0].accountId).select('+credential');
    expect(account.enabled).toBe(false);
    expect(account.credential).not.toContain('source-key');
    expect(secrets.decrypt(account.credential, String(account._id))).toBe('source-key');
    expect((await partners.findById(partner._id)).token_api).toBe('source-key');
    expect(await orders.countDocuments({ partner_id: partner._id })).toBe(0);
    expect(await services.countDocuments({ partner: partner._id })).toBe(0);
    await partners.updateOne({ _id: partner._id }, { $set: { token_api: 'new-source-key' } });
    await migration.copy(String(partner._id), body);
    const unchanged = await accounts.findById(account._id).select('+credential');
    expect(unchanged.credential).toBe(account.credential);
    await expect(migration.copy(String(partner._id), { ...body, connectorVersion: 2 })).rejects.toThrow('preserved');
  });
  it('concurrent same-key checkouts debit once and create one durable order/journal', async () => {
    const f = await fixture();
    const responses = await Promise.all(Array.from({ length: 6 }, () => checkout.commit(f.request)));
    expect(new Set(responses.map(row => row.data.order_id)).size).toBe(1);
    expect((await users.findById(f.userId)).money).toBe(900);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(1);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(1);
    expect(await checkout.replay(f.request.userId, f.request.key, f.request.payload)).toEqual(responses[0]);
    await expect(checkout.replay(f.request.userId, f.request.key, { ...f.request.payload, quantity: 2 })).rejects.toThrow('mismatch');
  });
  it('rolls back debit, order and service claim when journal persistence fails', async () => {
    const f = await fixture();
    jest.spyOn(wallet, 'create').mockRejectedValueOnce(new Error('journal outage'));
    await expect(checkout.commit(f.request)).rejects.toThrow('journal outage');
    expect((await users.findById(f.userId)).money).toBe(1000);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(0);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(0);
    expect((await services.findById(f.serviceId).select('+connector_checkout_revision')).connector_checkout_revision).toBe(0);
    const retry = await checkout.commit(f.request);
    expect(retry.data.balance_after).toBe(900);
  });
  it('rejects changed service prices before debit', async () => {
    const f = await fixture();
    await services.updateOne({ _id: f.serviceId }, { $set: { 'pricing.30.price': 200, updatedAt: new Date(Date.now() + 5000) } });
    await expect(checkout.commit(f.request)).rejects.toThrow('Service changed');
    expect((await users.findById(f.userId)).money).toBe(1000);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(0);
  });
  it('recovers a committed checkout when the transaction acknowledgement is lost', async () => {
    const f = await fixture();
    const startSession = db.startSession.bind(db);
    jest.spyOn(db, 'startSession').mockImplementationOnce(async (...args: any[]) => {
      const session = await startSession(...args);
      const transact = session.withTransaction.bind(session);
      jest.spyOn(session, 'withTransaction').mockImplementationOnce(async (callback: any, options: any) => {
        await transact(callback, options);
        throw new Error('simulated lost commit acknowledgement');
      });
      return session;
    });
    const result = await checkout.commit(f.request);
    expect(result.data.balance_after).toBe(900);
    expect(await checkout.commit(f.request)).toEqual(result);
    expect((await users.findById(f.userId)).money).toBe(900);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(1);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(1);
  });
  it('rejects competing payloads using the same idempotency key without a second debit', async () => {
    const f = await fixture();
    const other = { ...f.request, payload: { ...f.request.payload, quantity: 2 },
      order: { ...f.request.order, quantity: 2, total_price: 200 } };
    const results = await Promise.allSettled([checkout.commit(f.request), checkout.commit(other)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.message).toContain('mismatch');
    const winner = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
    expect((await users.findById(f.userId)).money).toBe(winner.data.balance_after);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(1);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(1);
  });
  it('serializes different checkout keys against the same service without losing wallet debits', async () => {
    const f = await fixture();
    const other = { ...f.request, key: `${f.request.key}-second`,
      order: { ...f.request.order, order_code: `TEST-${new Types.ObjectId()}` } };
    const results = await Promise.all([checkout.commit(f.request), checkout.commit(other)]);
    expect(new Set(results.map(result => result.data.order_id)).size).toBe(2);
    expect((await users.findById(f.userId)).money).toBe(800);
    expect(await orders.countDocuments({ user_id: f.userId })).toBe(2);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(2);
  });
  async function deliveryFixture() {
    const f = await fixture(); const response = await checkout.commit(f.request);
    const orderId = response.data.order_id;
    await orders.updateOne({ _id: orderId }, { $set: { status: OrderStatusEnum.PROCESSING,
      connector_purchase_state: 'awaiting_delivery', provider_order_id: 'paid-order' } });
    const runtime = { read: jest.fn().mockResolvedValue({ fields: {}, items: [{ host: 'proxy.example.test', port: 8080,
      protocol: 'http', username: 'proxy-user', password: 'proxy-password' }] }) };
    const delivery = new ConnectorOrderDelivery(orders, proxies, runtime as any);
    return { ...f, orderId, runtime, delivery };
  }
  it('persists both endpoints once under concurrent dual delivery without a second debit', async () => {
    const f = await deliveryFixture();
    await orders.updateOne({ _id: f.orderId }, { $unset: { 'connector_purchase.input.protocol': '' },
      $set: { 'connector_purchase.protocolSelection': { mode: 'dual', protocols: ['http', 'socks5'] } } });
    f.runtime.read.mockResolvedValue({ fields: {}, items: [{ host: 'proxy.example.test', httpPort: 8080,
      socks5Port: 1080, username: 'proxy-user', password: 'proxy-password' }] } as any);
    const results = await Promise.all(Array.from({ length: 6 }, () => f.delivery.poll(f.orderId)));
    expect(results.filter(result => result.delivered)).toHaveLength(1);
    const stored = await proxies.find({ order_id: new Types.ObjectId(f.orderId) }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].access_endpoints).toEqual([{ protocol: 'http', port: 8080 }, { protocol: 'socks5', port: 1080 }]);
    expect((await orders.findById(f.orderId)).actual_quantity).toBe(1);
    expect(await wallet.countDocuments({ user_id: new Types.ObjectId(f.userId) })).toBe(1);
    expect((await users.findById(f.userId)).money).toBe(900);
  });
  async function purchaseFixture() {
    const f = await fixture();
    const pinned = f.request.order.connector_purchase;
    Object.assign(pinned.input, { username: 'test-proxy-user', password: 'test-proxy-password' });
    await accounts.create({ _id: pinned.accountId, name: 'Disposable purchase account', enabled: true,
      connectorCode: pinned.connectorCode, connectorVersion: pinned.connectorVersion,
      credential: secrets.encrypt('test-account-key', pinned.accountId) });
    const receipt = await checkout.commit(f.request);
    const orderId = receipt.data.order_id;
    const http = { execute: jest.fn().mockResolvedValue({ id: 'simulated-paid-order' }) };
    const purchase = new ConnectorOrderPurchase(orders, accounts,
      { publishedDefinition: jest.fn().mockResolvedValue(homeproxyPurchaseCandidate()) } as any,
      secrets, new ConnectorDispatches(dispatchModel, secrets), http as any);
    return { ...f, orderId, receipt, http, purchase };
  }
  it('runs checkout, concurrent purchase, and concurrent delivery with one debit and one simulated upstream write', async () => {
    const f = await purchaseFixture();
    const { orderId, receipt, http, purchase } = f;
    const purchases = await Promise.allSettled(Array.from({ length: 6 }, () => purchase.purchase(orderId)));
    expect(purchases.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(http.execute).toHaveBeenCalledTimes(1);
    expect(await dispatchModel.countDocuments({ orderId })).toBe(1);
    expect((await dispatchModel.findOne({ orderId })).status).toBe('completed');
    expect((await orders.findById(orderId)).connector_purchase_state).toBe('awaiting_delivery');
    const runtime = { read: jest.fn().mockResolvedValue({ fields: {}, items: [{ host: 'proxy.example.test', port: 8080,
      protocol: 'http', username: 'test-proxy-user', password: 'test-proxy-password', orderId: 'simulated-paid-order',
      expiresAt: new Date(Date.now() + 86400_000).toISOString() }] }) };
    const delivery = new ConnectorOrderDelivery(orders, proxies, runtime as any);
    const deliveries = await Promise.all(Array.from({ length: 6 }, () => delivery.poll(orderId)));
    expect(deliveries.filter(result => result.delivered)).toHaveLength(1);
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(orderId) })).toBe(1);
    expect((await orders.findById(orderId)).status).toBe(OrderStatusEnum.ACTIVE);
    expect((await users.findById(f.userId)).money).toBe(900);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(1);
    await expect(purchase.purchase(orderId)).rejects.toThrow();
    expect(await checkout.replay(f.request.userId, f.request.key, f.request.payload)).toEqual(receipt);
    expect(http.execute).toHaveBeenCalledTimes(1);
  });
  it('fences an ambiguous provider response across worker restarts without refunding or purchasing twice', async () => {
    const f = await purchaseFixture();
    f.http.execute.mockRejectedValue(new Error('simulated lost upstream response'));
    await expect(f.purchase.purchase(f.orderId)).rejects.toThrow('requires reconciliation');
    const pending = await orders.findById(f.orderId);
    expect(pending.status).toBe(OrderStatusEnum.PROCESSING);
    expect(pending.payment_status).toBe(PaymentStatusEnum.PAID);
    expect(pending.connector_purchase_state).toBe('reconciliation');
    expect((await dispatchModel.findOne({ orderId: f.orderId })).status).toBe('unknown');
    const restarted = new ConnectorOrderPurchase(orders, accounts,
      { publishedDefinition: jest.fn().mockResolvedValue(homeproxyPurchaseCandidate()) } as any,
      secrets, new ConnectorDispatches(dispatchModel, secrets), f.http as any);
    expect(await restarted.recover(f.orderId)).toBe(false);
    await expect(restarted.purchase(f.orderId)).rejects.toThrow();
    expect(f.http.execute).toHaveBeenCalledTimes(1);
    expect(await dispatchModel.countDocuments({ orderId: f.orderId })).toBe(1);
    expect((await users.findById(f.userId)).money).toBe(900);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(1);
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(f.orderId) })).toBe(0);
  });
  it('recovers an encrypted accepted result after order projection fails without another upstream write', async () => {
    const f = await purchaseFixture();
    const updateOne = orders.updateOne.bind(orders);
    jest.spyOn(orders, 'updateOne').mockImplementation((filter: any, update: any, ...rest: any[]) => {
      if (update.$set?.provider_order_id === 'simulated-paid-order') {
        return Promise.reject(new Error('simulated order projection outage'));
      }
      return updateOne(filter, update, ...rest);
    });
    await expect(f.purchase.purchase(f.orderId)).rejects.toThrow('requires reconciliation');
    const dispatch = await dispatchModel.findOne({ orderId: f.orderId }).select('+encryptedResult');
    expect(dispatch.status).toBe('unknown');
    expect(dispatch.encryptedResult).toBeTruthy();
    expect(dispatch.encryptedResult).not.toContain('simulated-paid-order');
    jest.restoreAllMocks();
    const restarted = new ConnectorOrderPurchase(orders, accounts,
      { publishedDefinition: jest.fn().mockResolvedValue(homeproxyPurchaseCandidate()) } as any,
      secrets, new ConnectorDispatches(dispatchModel, secrets), f.http as any);
    const results = await Promise.all(Array.from({ length: 6 }, () => restarted.recover(f.orderId)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const order = await orders.findById(f.orderId);
    expect(order.connector_purchase_state).toBe('awaiting_delivery');
    expect(order.provider_order_id).toBe('simulated-paid-order');
    expect(await restarted.recover(f.orderId)).toBe(false);
    await expect(restarted.purchase(f.orderId)).rejects.toThrow();
    expect(f.http.execute).toHaveBeenCalledTimes(1);
    expect((await users.findById(f.userId)).money).toBe(900);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(1);
  });
  it('concurrent delivery polls fulfill exactly once with a single proxy', async () => {
    const f = await deliveryFixture();
    const results = await Promise.all(Array.from({ length: 6 }, () => f.delivery.poll(f.orderId)));
    expect(results.filter(row => row.delivered)).toHaveLength(1);
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(f.orderId) })).toBe(1);
    const order = await orders.findById(f.orderId);
    expect(order.status).toBe(OrderStatusEnum.ACTIVE);
    expect(order.payment_status).toBe(PaymentStatusEnum.PAID);
    expect(order.connector_purchase_state).toBe('delivered');
    expect(order.start_date).toBeInstanceOf(Date);
    expect(order.end_date.getTime() - order.start_date.getTime()).toBe(30 * 86400_000);
  });
  it('persists a shorter provider lease without extending it to the purchased duration', async () => {
    const f = await deliveryFixture();
    const expiresAt = new Date(Date.now() + 2 * 86400_000).toISOString();
    f.runtime.read.mockResolvedValue({ fields: {}, items: [{ host: 'proxy.example.test', port: 8080,
      protocol: 'http', username: 'proxy-user', password: 'proxy-password', orderId: 'paid-order', expiresAt }] } as any);
    expect(await f.delivery.poll(f.orderId)).toEqual({ delivered: true, quantity: 1 });
    expect((await orders.findById(f.orderId)).end_date.toISOString()).toBe(expiresAt);
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(f.orderId) })).toBe(1);
  });
  it('quarantines a wrong-order read before any delivery or wallet mutation', async () => {
    const f = await deliveryFixture();
    f.runtime.read.mockResolvedValue({ fields: {}, items: [{ host: 'proxy.example.test', port: 8080,
      protocol: 'http', username: 'proxy-user', password: 'proxy-password', orderId: 'unrelated-order' }] } as any);
    await expect(f.delivery.poll(f.orderId)).rejects.toThrow('different order');
    const unchanged = await orders.findById(f.orderId);
    expect(unchanged.status).toBe(OrderStatusEnum.PROCESSING);
    expect(unchanged.connector_purchase_state).toBe('awaiting_delivery');
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(f.orderId) })).toBe(0);
    expect((await users.findById(f.userId)).money).toBe(900);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(1);
  });
  it('rolls back ACTIVE transition when proxy insertion fails, then safely retries read delivery', async () => {
    const f = await deliveryFixture();
    jest.spyOn(proxies, 'insertMany').mockRejectedValueOnce(new Error('proxy storage outage'));
    await expect(f.delivery.poll(f.orderId)).rejects.toThrow('proxy storage outage');
    const pending = await orders.findById(f.orderId);
    expect(pending.status).toBe(OrderStatusEnum.PROCESSING);
    expect(pending.connector_purchase_state).toBe('awaiting_delivery');
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(f.orderId) })).toBe(0);
    expect(await f.delivery.poll(f.orderId)).toEqual({ delivered: true, quantity: 1 });
    expect((await users.findById(f.userId)).money).toBe(900);
    expect(await wallet.countDocuments({ user_id: f.userId })).toBe(1);
  });
  it.each(['wrong-protocol', 'blank-password', 'expired-local-end', 'upstream-before-start'])(
    'preserves the paid order and wallet when delivery is unsafe: %s', async reason => {
      const f = await deliveryFixture();
      const item: Record<string, unknown> = { host: 'proxy.example.test', port: 8080,
        protocol: 'http', username: 'proxy-user', password: 'proxy-password' };
      if (reason === 'wrong-protocol') item.protocol = 'socks5';
      if (reason === 'blank-password') item.password = '  ';
      if (reason === 'expired-local-end') await orders.updateOne({ _id: f.orderId }, {
        $set: { end_date: new Date(Date.now() - 86400_000) } });
      if (reason === 'upstream-before-start') {
        await orders.updateOne({ _id: f.orderId }, { $set: { start_date: new Date(Date.now() + 2 * 86400_000) } });
        item.expiresAt = new Date(Date.now() + 86400_000).toISOString();
      }
      f.runtime.read.mockResolvedValue({ fields: {}, items: [item] } as any);
      await expect(f.delivery.poll(f.orderId)).rejects.toThrow();
      const order = await orders.findById(f.orderId);
      expect(order.status).toBe(OrderStatusEnum.PROCESSING);
      expect(order.connector_purchase_state).toBe('awaiting_delivery');
      expect(order.payment_status).toBe(PaymentStatusEnum.PAID);
      expect(await proxies.countDocuments({ order_id: new Types.ObjectId(f.orderId) })).toBe(0);
      expect((await users.findById(f.userId)).money).toBe(900);
      expect(await wallet.countDocuments({ user_id: f.userId })).toBe(1);
    });
  it.each(['quantity', 'duration_days', 'start_date', 'end_date'])(
    'does not fulfill a stale snapshot when %s changes during the provider read', async field => {
      const f = await deliveryFixture();
      f.runtime.read.mockImplementationOnce(async () => {
        const value = field === 'quantity' ? 2 : field === 'duration_days' ? 7 : new Date(Date.now() + 86400_000);
        await orders.updateOne({ _id: f.orderId }, { $set: { [field]: value } });
        return { fields: {}, items: [{ host: 'proxy.example.test', port: 8080,
          protocol: 'http', username: 'proxy-user', password: 'proxy-password' }] };
      });
      expect(await f.delivery.poll(f.orderId)).toEqual({ delivered: false });
      const order = await orders.findById(f.orderId);
      expect(order.status).toBe(OrderStatusEnum.PROCESSING);
      expect(order.connector_purchase_state).toBe('awaiting_delivery');
      expect(await proxies.countDocuments({ order_id: new Types.ObjectId(f.orderId) })).toBe(0);
      expect((await users.findById(f.userId)).money).toBe(900);
    });
  it('keeps committed delivery durable after a lost commit acknowledgement without inserting proxies twice', async () => {
    const f = await deliveryFixture();
    const startSession = db.startSession.bind(db);
    jest.spyOn(db, 'startSession').mockImplementationOnce(async (...args: any[]) => {
      const session = await startSession(...args);
      const transact = session.withTransaction.bind(session);
      jest.spyOn(session, 'withTransaction').mockImplementationOnce(async (callback: any, options: any) => {
        await transact(callback, options);
        throw new Error('simulated delivery commit acknowledgement loss');
      });
      return session;
    });
    await expect(f.delivery.poll(f.orderId)).rejects.toThrow('acknowledgement loss');
    expect(await f.delivery.poll(f.orderId)).toEqual({ delivered: false });
    expect(f.runtime.read).toHaveBeenCalledTimes(1);
    const order = await orders.findById(f.orderId);
    expect(order.status).toBe(OrderStatusEnum.ACTIVE);
    expect(order.connector_affiliate_pending).toBe(true);
    expect(await proxies.countDocuments({ order_id: new Types.ObjectId(f.orderId) })).toBe(1);
    expect((await users.findById(f.userId)).money).toBe(900);
  });
  it('recovers affiliate processing after a crash and concurrent retries without duplicate commissions', async () => {
    const f = await deliveryFixture();
    const referrerId = new Types.ObjectId();
    await users.collection.insertOne({ _id: referrerId, email: `${referrerId}@example.test`,
      topup_code: String(referrerId), referral_code: String(referrerId), commission_rate: 10 });
    await users.updateOne({ _id: f.userId }, { $set: { referred_by: referrerId } });
    await configs.create({ is_active: true, commission_rate: 10 });
    await f.delivery.poll(f.orderId);
    expect((await orders.findById(f.orderId)).connector_affiliate_pending).toBe(true);
    await Promise.all(Array.from({ length: 6 }, () => effects.reconcile(f.orderId)));
    expect(await commissions.countDocuments({ order_id: new Types.ObjectId(f.orderId) })).toBe(1);
    expect((await orders.findById(f.orderId)).connector_affiliate_pending).toBe(false);
    expect(await effects.reconcile(f.orderId)).toBe(false);
  });
});
