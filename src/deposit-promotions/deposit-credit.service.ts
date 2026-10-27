import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { assertDepositEnabled } from '../common/commerce-policy';
import { Transaction, TransactionDocument, TransactionStatus, PaymentMethod } from '../schemas/transactions.schema';
import { User, UserDocument } from '../schemas/users.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTxType } from '../schemas/wallet-transaction.schema';
import { DepositPromotionsService, calculateQuote, vnd } from './deposit-promotions.service';

@Injectable()
export class DepositCreditService {
  constructor(
    @InjectModel(Transaction.name) private readonly transactions: Model<TransactionDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(WalletTransaction.name) private readonly ledger: Model<WalletTransactionDocument>,
    private readonly promotions: DepositPromotionsService,
  ) {}

  async credit(id: string, userId: string, actor = 'webhook') {
    assertDepositEnabled();
    let tx = await this.transactions.findById(id).lean().exec();
    if (!tx) throw new BadRequestException('Transaction not found');
    // Historical processed transactions predate this protocol: never credit again.
    if (tx.status === TransactionStatus.PROCESSED && !tx.credit_plan) return tx;
    if (tx.status === TransactionStatus.REJECTED || tx.transfer_type !== 'IN') throw new BadRequestException('Transaction cannot be credited');
    const amount = vnd(tx.transfer_amount, 10_000);
    const key = tx._id.toString();
    if (!tx.credit_plan) {
      const quote = tx.payment_method === PaymentMethod.BANK && tx.source !== 'manual'
        ? await this.promotions.claim(tx.content, userId, amount, new Date(tx.transaction_date), key)
        : calculateQuote(amount);
      const plan = { userId, quote, actor, at: new Date() };
      tx = await this.transactions.findOneAndUpdate(
        { _id: tx._id, credit_plan: null, status: { $nin: [TransactionStatus.REJECTED, TransactionStatus.PROCESSED] } },
        { $set: { credit_plan: plan, user_id: new Types.ObjectId(userId), status: TransactionStatus.CREDITING } },
        { new: true },
      ).lean().exec() ?? await this.transactions.findById(id).lean().exec();
    }
    if (!tx?.credit_plan) throw new BadRequestException('Transaction state changed; retry');
    const plan = tx.credit_plan;
    if (plan.userId !== userId) throw new BadRequestException('Transaction is assigned to another user');
    const total = vnd(plan.quote.totalAmount);
    // The receipt and balance increment commit in ONE User document update.
    // Pipeline captures exact before/after balances even alongside other wallet writes.
    const user = await this.users.findOneAndUpdate({
      _id: new Types.ObjectId(userId),
      'deposit_credit_receipts.key': { $ne: key },
      money: { $gte: 0, $lte: Number.MAX_SAFE_INTEGER - total },
      $expr: { $eq: ['$money', { $trunc: '$money' }] },
    }, [{ $set: {
      money: { $add: ['$money', total] },
      deposit_credit_receipts: { $concatArrays: [{ $ifNull: ['$deposit_credit_receipts', []] }, [{
        key: { $literal: key }, quote: { $literal: plan.quote },
        balanceBefore: '$money', balanceAfter: { $add: ['$money', total] }, at: { $literal: plan.at },
      }]] },
    } }], { new: true, updatePipeline: true }).select('+deposit_credit_receipts').lean().exec();
    const durableUser = user ?? await this.users.findById(userId).select('+deposit_credit_receipts').lean().exec();
    const receipt = durableUser?.deposit_credit_receipts?.find(r => r.key === key);
    if (!receipt) throw new BadRequestException('User missing or balance is not safe integer VND');
    const q = receipt.quote;
    const entries = [{ type: WalletTxType.DEPOSIT, amount: q.amount, before: receipt.balanceBefore, after: receipt.balanceBefore + q.amount }];
    if (q.bonusAmount) entries.push({ type: WalletTxType.PROMOTION_BONUS, amount: q.bonusAmount, before: receipt.balanceBefore + q.amount, after: receipt.balanceAfter });
    for (const entry of entries) {
      const credit_key = `${key}:${entry.type}`;
      try {
        await this.ledger.updateOne({ credit_key }, { $setOnInsert: {
          credit_key, user_id: new Types.ObjectId(userId), type: entry.type, amount: entry.amount,
          direction: 'in', balance_before: entry.before, balance_after: entry.after,
          description: entry.type === WalletTxType.DEPOSIT ? 'Bank deposit' : `Deposit promotion: ${q.promotionName}`,
          ref_id: key, ref_type: 'bank_transaction', created_by: plan.actor,
        } }, { upsert: true }).exec();
      } catch (e: any) {
        if (e.code !== 11000 || !await this.ledger.exists({ credit_key })) throw e;
      }
    }
    return this.transactions.findByIdAndUpdate(id, { $set: {
      status: TransactionStatus.PROCESSED, promotion_snapshot: q, credited_at: receipt.at,
      balance_before: receipt.balanceBefore, balance_after: receipt.balanceAfter,
    } }, { new: true }).lean().exec();
  }
}
