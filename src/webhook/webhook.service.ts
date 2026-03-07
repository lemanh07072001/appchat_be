import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { Transaction, TransactionDocument, TransactionStatus } from '../schemas/transactions.schema';
import { User, UserDocument } from '../schemas/users.schema';
import { NotificationGateway } from './notification.gateway';

interface Pays2Transaction {
  id: number;
  gateway: string;
  transactionDate: string;
  transactionNumber: string;
  accountNumber: string;
  content: string;
  transferType: string;
  transferAmount: number;
  checksum: string;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectModel(Transaction.name) private txModel: Model<TransactionDocument>,
    @InjectModel(User.name)        private userModel: Model<UserDocument>,
    private readonly notification: NotificationGateway,
  ) {}

  // ─── Xác minh checksum pays2 ──────────────────────────────────────────────
  // Formula: md5(id + gateway + transactionDate + accountNumber + transferAmount + PAYS2_CHECKSUM_KEY)
  private verifyChecksum(tx: Pays2Transaction): boolean {
    const key = process.env.PAYS2_CHECKSUM_KEY ?? '';
    if (!key) {
      this.logger.warn('PAYS2_CHECKSUM_KEY chưa được cấu hình, bỏ qua xác minh checksum');
      return true;
    }
    const raw = `${tx.id}${tx.gateway}${tx.transactionDate}${tx.accountNumber}${tx.transferAmount}${key}`;
    const computed = crypto.createHash('md5').update(raw).digest('hex');
    this.logger.debug(`Checksum raw: "${raw}"`);
    this.logger.debug(`Computed: ${computed} | Expected: ${tx.checksum}`);
    return computed === tx.checksum;
  }

  // ─── Tìm user theo mã nạp tiền trong nội dung CK ─────────────────────────
  // User cần ghi topup_code (VD: NAP3F9A2C1D) vào nội dung chuyển khoản
  private async findUserFromContent(content: string): Promise<UserDocument | null> {
    const text = content.toUpperCase();

    // 1. Tìm topup_code dạng NAP + 8 ký tự hex
    const match = text.match(/NAP[0-9A-F]{8}/);
    this.logger.debug(`findUser — content: "${content}" | match: ${match?.[0] ?? 'null'}`);
    if (match) {
      const user = await this.userModel
        .findOne({ topup_code: match[0] })
        .select('_id email money topup_code')
        .exec();
      this.logger.debug(`findUser — topup_code: ${match[0]} | user: ${user?.email ?? 'not found'}`);
      if (user) return user;
    }
    

    // 2. Fallback: tìm theo email trong nội dung
    const emailMatch = content.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      const user = await this.userModel
        .findOne({ email: emailMatch[0].toLowerCase() })
        .select('_id email money topup_code')
        .exec();
      if (user) return user;
    }

    return null;
  }

  // ─── Xử lý webhook từ pays2 ───────────────────────────────────────────────
  async handlePays2(body: { transactions: Pays2Transaction[] }): Promise<{ success: boolean; message: string }> {
    const results: string[] = [];

    for (const tx of body.transactions) {
      try {
        // 1. Chỉ xử lý giao dịch tiền vào
        if (tx.transferType !== 'IN') {
          results.push(`#${tx.id}: bỏ qua (${tx.transferType})`);
          continue;
        }

        // 2. Tìm user từ nội dung CK (trước checksum để có user_id khi log)
        const code = tx.content.toUpperCase().match(/NAP[0-9A-F]{8}/)?.[0] ?? '';
        const user = await this.findUserFromContent(tx.content);

        // 3. Xác minh checksum
        if (!this.verifyChecksum(tx)) {
          await this.txModel.create({
            transaction_id:     tx.id,
            gateway:            tx.gateway,
            transaction_date:   new Date(tx.transactionDate),
            transaction_number: tx.transactionNumber,
            account_number:     tx.accountNumber,
            content:            tx.content,
            code,
            transfer_type:      tx.transferType,
            transfer_amount:    Number(tx.transferAmount),
            checksum:           tx.checksum,
            status:             TransactionStatus.FAILED,
            user_id:            user?._id ?? null,
            note:               'Checksum không hợp lệ',
          });
          results.push(`#${tx.id}: checksum invalid`);
          continue;
        }

        if (!user) {
          // User không tồn tại — lưu lại để admin xử lý sau
          await this.txModel.create({
            transaction_id:     tx.id,
            gateway:            tx.gateway,
            transaction_date:   new Date(tx.transactionDate),
            transaction_number: tx.transactionNumber,
            account_number:     tx.accountNumber,
            content:            tx.content,
            code,
            transfer_type:      tx.transferType,
            transfer_amount:    tx.transferAmount,
            checksum:           tx.checksum,
            status:             TransactionStatus.UNMATCHED,
            note:               'Không tìm được user trong nội dung CK',
          });
          this.logger.warn(`Webhook #${tx.id}: không match user — content: "${tx.content}"`);
          results.push(`#${tx.id}: unmatched`);
          continue;
        }

        // 4. Kiểm tra trùng giao dịch
        const existing = await this.txModel.findOne({ transaction_id: tx.id }).exec();
        if (existing) {
          // Trùng giao dịch — chuyển sang chờ xử lý để admin xem xét thủ công
          await this.txModel.findByIdAndUpdate(existing._id, {
            status: TransactionStatus.PENDING,
            user_id: user._id,
            note:   `Trùng giao dịch — user: ${user.email}, cần admin xác nhận`,
          }).exec();
          this.logger.warn(`Webhook #${tx.id}: trùng giao dịch — user: ${user.email}`);
          results.push(`#${tx.id}: duplicate → pending`);
          continue;
        }

        // 5. User đúng + không trùng → cộng tiền
        const amount        = Number(tx.transferAmount);
        const balanceBefore = Number(user.money ?? 0);
        const balanceAfter  = balanceBefore + amount;

        await this.userModel.findByIdAndUpdate(
          user._id,
          { $inc: { money: amount } },
        ).exec();

        await this.txModel.create({
          transaction_id:     tx.id,
          gateway:            tx.gateway,
          transaction_date:   new Date(tx.transactionDate),
          transaction_number: tx.transactionNumber,
          account_number:     tx.accountNumber,
          content:            tx.content,
          code,
          transfer_type:      tx.transferType,
          transfer_amount:    amount,
          checksum:           tx.checksum,
          status:             TransactionStatus.PROCESSED,
          user_id:            user._id,
          balance_before:     balanceBefore,
          balance_after:      balanceAfter,
          note:               `Nạp ${amount.toLocaleString('vi-VN')}đ cho ${user.email}`,
        });

        this.logger.log(`Webhook #${tx.id}: nạp ${tx.transferAmount}đ → ${user.email} (${balanceBefore} → ${balanceAfter})`);
        this.notification.sendTopupSuccess(user._id.toString(), { amount, balance: balanceAfter });
        results.push(`#${tx.id}: processed → ${user.email}`);

      } catch (err: any) {
        this.logger.error(`Webhook #${tx.id}: lỗi — ${err?.message}`);
        results.push(`#${tx.id}: error — ${err?.message}`);
      }
    }

    return { success: true, message: results.join(', ') };
  }

  // ─── API thống kê (admin) ─────────────────────────────────────────────────
  async getStats() {
    const [total, processed, unmatched, failed, duplicate, totalAmount] = await Promise.all([
      this.txModel.countDocuments({ transfer_type: 'IN' }),
      this.txModel.countDocuments({ status: TransactionStatus.PROCESSED }),
      this.txModel.countDocuments({ status: TransactionStatus.UNMATCHED }),
      this.txModel.countDocuments({ status: TransactionStatus.FAILED }),
      this.txModel.countDocuments({ status: TransactionStatus.DUPLICATE }),
      this.txModel.aggregate([
        { $match: { status: TransactionStatus.PROCESSED } },
        { $group: { _id: null, total: { $sum: '$transfer_amount' } } },
      ]),
    ]);

    return {
      total,
      processed,
      unmatched,
      failed,
      duplicate,
      total_amount: totalAmount[0]?.total ?? 0,
    };
  }

  async getList(page = 1, limit = 20, status?: string, source?: string, from_date?: string, to_date?: string) {
    const filter: any = {};
    if (status) filter.status = status;
    if (source) filter.source = source;
    if (from_date || to_date) {
      filter.createdAt = {};
      if (from_date) filter.createdAt.$gte = new Date(from_date + 'T00:00:00+07:00');
      if (to_date)   filter.createdAt.$lte = new Date(to_date   + 'T23:59:59.999+07:00');
    }
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.txModel
        .find(filter)
        .populate('user_id', 'email name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.txModel.countDocuments(filter),
    ]);

    return { data, total, page, limit };
  }

  // ─── Admin: duyệt giao dịch lỗi — cộng tiền bằng tay ─────────────────
  async approveTransaction(txId: string, userId?: string) {
    const tx = await this.txModel.findById(txId).exec();
    if (!tx) throw new BadRequestException('Giao dịch không tồn tại');
    if (tx.status === TransactionStatus.PROCESSED) {
      throw new BadRequestException('Giao dịch này đã được xử lý');
    }

    // Nếu giao dịch chưa có user_id (unmatched), admin phải truyền user_id
    const targetUserId = userId || tx.user_id;
    if (!targetUserId) {
      throw new BadRequestException('Cần truyền user_id để cộng tiền');
    }

    const user = await this.userModel.findById(targetUserId).select('_id email money').exec();
    if (!user) throw new BadRequestException('User không tồn tại');

    const amount = tx.transfer_amount;
    const balanceBefore = Number(user.money ?? 0);
    const balanceAfter = balanceBefore + amount;

    await this.userModel.findByIdAndUpdate(user._id, { $inc: { money: amount } }).exec();

    tx.status = TransactionStatus.PROCESSED;
    tx.user_id = user._id;
    tx.balance_before = balanceBefore;
    tx.balance_after = balanceAfter;
    tx.source = 'manual';
    tx.note = `Admin duyệt — nạp ${amount.toLocaleString('vi-VN')}đ cho ${user.email}`;
    await tx.save();

    this.notification.sendTopupSuccess(user._id.toString(), { amount, balance: balanceAfter });

    return { message: `Đã cộng ${amount.toLocaleString('vi-VN')}đ cho ${user.email}`, transaction: tx };
  }

  // ─── Admin: huỷ giao dịch ─────────────────────────────────────────────
  async rejectTransaction(txId: string, note?: string) {
    const tx = await this.txModel.findById(txId).exec();
    if (!tx) throw new BadRequestException('Giao dịch không tồn tại');
    if (tx.status === TransactionStatus.PROCESSED) {
      throw new BadRequestException('Không thể huỷ giao dịch đã xử lý');
    }

    tx.status = TransactionStatus.REJECTED;
    tx.note = note || 'Admin huỷ giao dịch';
    await tx.save();

    return { message: 'Đã huỷ giao dịch', transaction: tx };
  }
}
