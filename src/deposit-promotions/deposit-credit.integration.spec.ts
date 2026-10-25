import { createConnection, Connection, Types } from 'mongoose';
import { DepositCreditService } from './deposit-credit.service';
import { DepositPromotionsService } from './deposit-promotions.service';
import { DepositIntent, DepositIntentSchema, DepositPromotionCatalog, DepositPromotionCatalogSchema } from './deposit-promotions.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { Transaction, TransactionSchema } from '../schemas/transactions.schema';
import { WalletTransaction, WalletTransactionSchema } from '../schemas/wallet-transaction.schema';
import { WebhookService } from '../webhook/webhook.service';
import { WebhookLog, WebhookLogSchema } from '../schemas/webhook-log.schema';

// Only this test process bypasses commerce shutdown. Production flag is untouched.
jest.mock('../common/commerce-policy', () => ({ assertCommerceEnabled: jest.fn() }));
jest.mock('../common/feature-flags', () => ({ featureFlags: { depositEnabled: true } }));

// Explicit opt-in: creates and drops ONLY a uniquely named disposable database.
const mongo = process.env.DEPOSIT_TEST_MONGO_URI;
(mongo ? describe : describe.skip)('Standalone Mongo durable deposit credit', () => {
  let connection: Connection;
  let users: any, transactions: any, ledger: any, intents: any, logs: any, promotions: DepositPromotionsService, credit: DepositCreditService;
  beforeAll(async () => {
    connection = await createConnection(mongo!, { dbName: `deposit_promotion_test_${new Types.ObjectId()}` }).asPromise();
    users = connection.model(User.name, UserSchema);
    transactions = connection.model(Transaction.name, TransactionSchema);
    ledger = connection.model(WalletTransaction.name, WalletTransactionSchema);
    intents = connection.model(DepositIntent.name, DepositIntentSchema);
    logs = connection.model(WebhookLog.name, WebhookLogSchema);
    const catalog = connection.model(DepositPromotionCatalog.name, DepositPromotionCatalogSchema);
    await Promise.all([users.init(), transactions.init(), ledger.init(), intents.init(), catalog.init()]);
    promotions = new DepositPromotionsService(catalog, intents);
    credit = new DepositCreditService(transactions, users, ledger, promotions);
  });
  afterAll(async () => { if (connection) { await connection.dropDatabase(); await connection.close(); } });

  async function fixture() {
    const user = await users.create({ name: 'Test', email: `${new Types.ObjectId()}@example.test`, password: 'unused', money: 5000, topup_code: new Types.ObjectId().toString(), referral_code: new Types.ObjectId().toString() });
    const intent = await promotions.createIntent(user._id.toString(), 100_000);
    const tx = await transactions.create({ transaction_id: Date.now() + Math.floor(Math.random() * 100_000), gateway: 'TEST', transaction_date: new Date(), transfer_amount: 100_000, content: intent.code });
    return { user, intent, tx };
  }

  function bankTransfer(tx: any) {
    return { id: tx.transaction_id, gateway: 'TEST', transactionDate: tx.transaction_date.toISOString(), transactionNumber: '', accountNumber: '', content: tx.content, transferType: 'IN', transferAmount: tx.transfer_amount, checksum: '' };
  }

  it('serializes overlapping active program writes', async () => {
    const body = { name: 'Bonus', status: 'active', start: '2020-01-01', end: '2099-01-01', maxBonus: 50_000, tiers: [{ minAmount: 10_000, rate: 10 }] };
    const results = await Promise.allSettled([promotions.save(body), promotions.save(body)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await promotions.list()).toHaveLength(1);
  });

  it('credits concurrent approvals once, with separate deposit and bonus ledger entries', async () => {
    const { user, tx } = await fixture();
    await Promise.all(Array.from({ length: 10 }, () => credit.credit(tx._id.toString(), user._id.toString())));
    expect((await users.findById(user._id)).money).toBe(115_000);
    expect(await ledger.countDocuments({ ref_id: tx._id.toString() })).toBe(2);
    expect((await transactions.findById(tx._id)).promotion_snapshot.bonusAmount).toBe(10_000);
  });

  it('recovers after ledger failure without another increment and preserves intent snapshot after edits', async () => {
    const { user, tx } = await fixture();
    const [program] = await promotions.list();
    await promotions.save({ ...program, tiers: [{ minAmount: 0, rate: 90 }] }, program._id);
    const failure = jest.spyOn(ledger, 'updateOne').mockImplementationOnce(() => ({ exec: async () => { throw new Error('injected ledger outage'); } }));
    await expect(credit.credit(tx._id.toString(), user._id.toString())).rejects.toThrow('injected ledger outage');
    failure.mockRestore();
    expect((await users.findById(user._id)).money).toBe(115_000);
    expect((await transactions.findById(tx._id)).status).toBe('crediting');
    await credit.credit(tx._id.toString(), user._id.toString());
    expect((await users.findById(user._id)).money).toBe(115_000);
    expect(await ledger.countDocuments({ ref_id: tx._id.toString() })).toBe(2);
  });

  it('rejects wrong owner/amount and intent reuse; expired transfers and legacy deposits receive no bonus', async () => {
    const { user, intent, tx } = await fixture();
    await expect(credit.credit(tx._id.toString(), new Types.ObjectId().toString())).rejects.toThrow('mismatch');
    await transactions.updateOne({ _id: tx._id }, { $set: { transfer_amount: 100_001 } });
    await expect(credit.credit(tx._id.toString(), user._id.toString())).rejects.toThrow('mismatch');
    await transactions.updateOne({ _id: tx._id }, { $set: { transfer_amount: 100_000 } });
    await credit.credit(tx._id.toString(), user._id.toString());
    const second = await transactions.create({ transaction_id: Date.now() + 1_000_000, gateway: 'TEST', transaction_date: new Date(), transfer_amount: 100_000, content: intent.code });
    await expect(credit.credit(second._id.toString(), user._id.toString())).rejects.toThrow('already used');
    await transactions.updateOne({ _id: second._id }, { $set: { transaction_date: new Date(new Date(intent.expiresAt).getTime() + 1) } });
    await credit.credit(second._id.toString(), user._id.toString());
    expect((await transactions.findById(second._id)).promotion_snapshot.bonusAmount).toBe(0);
    const legacy = await transactions.create({ transaction_id: Date.now() + 2_000_000, gateway: 'TEST', transaction_date: new Date(), transfer_amount: 100_000, content: user.topup_code });
    await credit.credit(legacy._id.toString(), user._id.toString());
    expect((await transactions.findById(legacy._id)).promotion_snapshot.bonusAmount).toBe(0);
  });

  it('recovers provider retries racing admin approval after transaction finalization failure', async () => {
    const { user, intent, tx } = await fixture();
    const failure = jest.spyOn(transactions, 'findByIdAndUpdate').mockImplementationOnce(() => ({ lean: () => ({ exec: async () => { throw new Error('injected finalization outage'); } }) }));
    await expect(credit.credit(tx._id.toString(), user._id.toString())).rejects.toThrow('finalization outage');
    failure.mockRestore();
    const balance = (await users.findById(user._id)).money;
    const notifications = { sendTopupSuccess: jest.fn() };
    const webhook = new WebhookService(transactions, users, {} as any, ledger, { create: async () => ({}) } as any, notifications as any, promotions, credit);
    const payload = { transactions: [{ id: tx.transaction_id, gateway: 'TEST', transactionDate: tx.transaction_date.toISOString(), transactionNumber: '', accountNumber: '', content: intent.code, transferType: 'IN', transferAmount: 100_000, checksum: '' }] };
    await Promise.all([webhook.handlePays2(payload), webhook.approveTransaction(tx._id.toString(), user.email)]);
    expect(notifications.sendTopupSuccess).toHaveBeenCalledTimes(1);
    expect(notifications.sendTopupSuccess).toHaveBeenCalledWith(user._id.toString(), {
      amount: 100_000, balance, bonusAmount: 50_000, totalAmount: 150_000, promotionName: 'Bonus',
    });
    await webhook.handlePays2(payload);
    await webhook.approveTransaction(tx._id.toString(), user.email);
    expect(notifications.sendTopupSuccess).toHaveBeenCalledTimes(1);
    expect((await users.findById(user._id)).money).toBe(balance);
    expect((await transactions.findById(tx._id)).status).toBe('processed');
    expect(await ledger.countDocuments({ ref_id: tx._id.toString() })).toBe(2);
  });

  it('returns promotion snapshots in user/admin history and exposes crediting for recovery', async () => {
    const { user, tx } = await fixture();
    const webhook = new WebhookService(transactions, users, {} as any, ledger, {} as any, {} as any, promotions, credit);
    await transactions.updateOne({ _id: tx._id }, { $set: { user_id: user._id } });
    const failure = jest.spyOn(ledger, 'updateOne').mockImplementationOnce(() => ({ exec: async () => { throw new Error('outage'); } }));
    await expect(credit.credit(tx._id.toString(), user._id.toString())).rejects.toThrow('outage');
    failure.mockRestore();
    const recovering = await webhook.getList(1, 20, 'crediting');
    expect(recovering.data.some(row => row._id.toString() === tx._id.toString())).toBe(true);
    expect(recovering.summary.total_crediting).toBeGreaterThan(0);
    expect((await webhook.getStats()).crediting).toBeGreaterThan(0);
    expect((await webhook.getUserTransactions(user._id.toString(), 1, 20, 'crediting')).total).toBe(1);
    await credit.credit(tx._id.toString(), user._id.toString());
    const userHistory = await webhook.getUserTransactions(user._id.toString());
    expect(userHistory.data[0].promotion_snapshot).toMatchObject({ amount: 100_000, bonusAmount: 50_000 });
    const adminHistory = await webhook.getList();
    const row = adminHistory.data.find(row => row._id.toString() === tx._id.toString());
    expect(row?.promotion_snapshot).toMatchObject({ amount: 100_000, bonusAmount: 50_000 });
    expect(row?.balance_after).toBe(155_000);
  });

  it('records a poison intent mismatch and still credits the next transfer and persists the batch log', async () => {
    const poison = await fixture(), valid = await fixture();
    const notifications = { sendTopupSuccess: jest.fn() };
    const webhook = new WebhookService(transactions, users, {} as any, ledger, logs, notifications as any, promotions, credit);
    // Make stored and incoming amounts agree, but differ from the intent amount.
    await transactions.updateOne({ _id: poison.tx._id }, { $set: { transfer_amount: 100_001 } });
    const payload = { transactions: [{ ...bankTransfer(poison.tx), transferAmount: 100_001 }, bankTransfer(valid.tx)] };
    const response = await webhook.handlePays2(payload, {}, 'batch-permanent');
    expect(response.success).toBe(true);
    expect(response.message).toContain('mismatch');
    expect((await users.findById(poison.user._id)).money).toBe(5000);
    expect((await users.findById(valid.user._id)).money).toBe(155_000);
    const log = await logs.findOne({ ip: 'batch-permanent' }).lean();
    expect(log.status_code).toBe(200);
    expect(log.payload.transactions).toHaveLength(2);
    expect(log.steps.some((step: any) => step.status === 'error' && step.detail.includes('mismatch'))).toBe(true);
    expect(log.response.message).toContain('processed');
    await webhook.handlePays2(payload);
    expect((await users.findById(valid.user._id)).money).toBe(155_000);
    expect(notifications.sendTopupSuccess).toHaveBeenCalledTimes(1);
  });

  it('finishes and logs the batch before signaling recoverable failure, then repairs safely on retry', async () => {
    const interrupted = await fixture(), valid = await fixture();
    const notifications = { sendTopupSuccess: jest.fn() };
    const webhook = new WebhookService(transactions, users, {} as any, ledger, logs, notifications as any, promotions, credit);
    const payload = { transactions: [bankTransfer(interrupted.tx), bankTransfer(valid.tx)] };
    const failure = jest.spyOn(ledger, 'updateOne').mockImplementationOnce(() => ({ exec: async () => { throw new Error('batch ledger outage'); } }));
    try {
      await expect(webhook.handlePays2(payload, {}, 'batch-retry')).rejects.toMatchObject({ status: 503 });
    } finally { failure.mockRestore(); }
    expect((await transactions.findById(interrupted.tx._id)).status).toBe('crediting');
    expect((await transactions.findById(valid.tx._id)).status).toBe('processed');
    expect((await users.findById(valid.user._id)).money).toBe(155_000);
    const log = await logs.findOne({ ip: 'batch-retry' }).lean();
    expect(log.status_code).toBe(503);
    expect(log.response.success).toBe(false);
    expect(log.response.message).toContain('batch ledger outage');
    expect(log.response.message).toContain('processed');
    await webhook.handlePays2(payload);
    for (const item of [interrupted, valid]) {
      expect((await users.findById(item.user._id)).money).toBe(155_000);
      expect((await transactions.findById(item.tx._id)).status).toBe('processed');
      expect(await ledger.countDocuments({ ref_id: item.tx._id.toString() })).toBe(2);
    }
    expect(notifications.sendTopupSuccess).toHaveBeenCalledTimes(2);
  });
});
