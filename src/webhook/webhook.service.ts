import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { Transaction, TransactionDocument, TransactionStatus } from '../schemas/transactions.schema';
import { User, UserDocument } from '../schemas/users.schema';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { WebhookLog, WebhookLogDocument, WebhookStep, WebhookStepStatus } from '../schemas/webhook-log.schema';
import { OrderStatusEnum } from '../enum/order.enum';
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
    @InjectModel(Transaction.name)  private txModel: Model<TransactionDocument>,
    @InjectModel(User.name)         private userModel: Model<UserDocument>,
    @InjectModel(Order.name)        private orderModel: Model<OrderDocument>,
    @InjectModel(WebhookLog.name)   private webhookLogModel: Model<WebhookLogDocument>,
    private readonly notification: NotificationGateway,
  ) {}

  // ─── Xác minh checksum pays2 ──────────────────────────────────────────────
  // Formula: md5(id + gateway + transactionDate + accountNumber + transferAmount + PAYS2_CHECKSUM_KEY)
  private verifyChecksum(tx: Pays2Transaction): boolean {
    const key = process.env.PAYS2_CHECKSUM_KEY ?? '';
    if (!key) {
      this.logger.error('PAYS2_CHECKSUM_KEY chưa được cấu hình — từ chối giao dịch');
      return false;
    }
    const raw = `${tx.id}${tx.gateway}${tx.transactionDate}${tx.accountNumber}${tx.transferAmount}${key}`;
    const computed = crypto.createHash('md5').update(raw).digest('hex');

    // DEBUG: in toàn bộ thông tin để so sánh
    console.log('===== PAYS2 CHECKSUM DEBUG =====');
    console.log('id          :', JSON.stringify(tx.id));
    console.log('gateway     :', JSON.stringify(tx.gateway));
    console.log('transDate   :', JSON.stringify(tx.transactionDate));
    console.log('accountNum  :', JSON.stringify(tx.accountNumber));
    console.log('amount      :', JSON.stringify(tx.transferAmount));
    console.log('key         :', JSON.stringify(key));
    console.log('raw string  :', JSON.stringify(raw));
    console.log('computed    :', computed);
    console.log('expected    :', tx.checksum);
    console.log('match       :', computed === tx.checksum);
    console.log('================================');

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
  async handlePays2(body: { transactions: Pays2Transaction[] }, headers?: Record<string, any>, ip?: string): Promise<{ success: boolean; message: string }> {
    const results: string[] = [];
    const allSteps: WebhookStep[] = [];

    for (const tx of body.transactions) {
      const steps: WebhookStep[] = [];
      const ok  = WebhookStepStatus.OK;
      const warn = WebhookStepStatus.WARN;
      const err  = WebhookStepStatus.ERROR;

      try {
        // Bước 1: Nhận webhook
        steps.push({
          step:   1,
          title:  'Hệ thống nhận webhook từ ngân hàng',
          detail: `Webhook từ pay2s lúc ${new Date().toLocaleTimeString('vi-VN')} ${new Date().toLocaleDateString('vi-VN')}, 1 giao dịch`,
          status: ok,
          data:   { ip, transaction_id: tx.id },
        });

        // 1. Chỉ xử lý giao dịch tiền vào
        if (tx.transferType !== 'IN') {
          steps.push({ step: 2, title: 'Loại giao dịch', detail: `Bỏ qua — loại ${tx.transferType}`, status: warn });
          allSteps.push(...steps);
          results.push(`#${tx.id}: bỏ qua (${tx.transferType})`);
          continue;
        }

        // Bước 2: Thông tin giao dịch ngân hàng
        const amount = Number(tx.transferAmount);
        steps.push({
          step:   2,
          title:  'Giao dịch ngân hàng',
          detail: `+${amount.toLocaleString('vi-VN')}đ từ ${tx.gateway}, mã: ${tx.transactionNumber}`,
          status: ok,
          data:   { gateway: tx.gateway, amount, account_number: tx.accountNumber, transaction_number: tx.transactionNumber },
        });

        // 2. Tìm user từ nội dung CK
        const code = tx.content.toUpperCase().match(/NAP[0-9A-F]{8}/)?.[0] ?? '';
        const user = await this.findUserFromContent(tx.content);

        // Bước 3: Khớp nội dung CK với user
        if (!user) {
          steps.push({
            step:   3,
            title:  'Nội dung CK khớp với user',
            detail: `Không tìm được user trong nội dung: "${tx.content}"`,
            status: err,
          });
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
            status:             TransactionStatus.UNMATCHED,
            note:               'Không tìm được user trong nội dung CK',
            raw_payload:        tx,
            raw_headers:        headers ?? null,
          });
          allSteps.push(...steps);
          results.push(`#${tx.id}: unmatched`);
          continue;
        }

        steps.push({
          step:   3,
          title:  'Nội dung CK khớp với user',
          detail: `Khớp user ${user.email.split('@')[0]} (${user.email})`,
          status: ok,
          data:   { user_id: user._id, email: user.email, code },
        });

        // 4. Atomic: kiểm tra trùng + tạo transaction
        const existing = await this.txModel.findOneAndUpdate(
          { transaction_id: tx.id },
          {
            $setOnInsert: {
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
              note:               `Nạp ${amount.toLocaleString('vi-VN')}đ cho ${user.email}`,
              raw_payload:        tx,
              raw_headers:        headers ?? null,
            },
          },
          { upsert: true, new: false },
        ).exec();

        if (existing) {
          steps.push({ step: 4, title: 'Lệnh nạp tiền', detail: `Trùng giao dịch #${tx.id} — bỏ qua`, status: warn });
          allSteps.push(...steps);
          results.push(`#${tx.id}: duplicate → skipped`);
          continue;
        }

        // Bước 4: Lệnh nạp tiền
        steps.push({
          step:   4,
          title:  'Lệnh nạp tiền',
          detail: `Lệnh nạp #${tx.id}: ${amount.toLocaleString('vi-VN')}đ (pay2s)`,
          status: ok,
          data:   { transaction_id: tx.id, amount },
        });

        // 5. Cộng tiền atomic
        const updatedUser = await this.userModel.findByIdAndUpdate(
          user._id,
          { $inc: { money: amount } },
          { new: true },
        ).exec();

        const balanceAfter  = Number(updatedUser?.money ?? 0);
        const balanceBefore = balanceAfter - amount;

        await this.txModel.findOneAndUpdate(
          { transaction_id: tx.id },
          { balance_before: balanceBefore, balance_after: balanceAfter },
        ).exec();

        // Bước 5: Tiền đã cộng
        steps.push({
          step:   5,
          title:  'Tiền đã cộng vào tài khoản',
          detail: `Cộng ${amount.toLocaleString('vi-VN')}đ. Số dư: ${balanceBefore.toLocaleString('vi-VN')} → ${balanceAfter.toLocaleString('vi-VN')}đ`,
          status: ok,
          data:   { balance_before: balanceBefore, balance_after: balanceAfter },
        });

        this.logger.log(`Webhook #${tx.id}: nạp ${amount}đ → ${user.email} (${balanceBefore} → ${balanceAfter})`);
        this.notification.sendTopupSuccess(user._id.toString(), { amount, balance: balanceAfter });
        allSteps.push(...steps);
        results.push(`#${tx.id}: processed → ${user.email}`);

      } catch (e: any) {
        steps.push({ step: steps.length + 1, title: 'Lỗi hệ thống', detail: e?.message ?? 'Unknown error', status: WebhookStepStatus.ERROR });
        allSteps.push(...steps);
        this.logger.error(`Webhook #${tx.id}: lỗi — ${e?.message}`);
        results.push(`#${tx.id}: error — ${e?.message}`);
      }
    }

    const response = { success: true, message: results.join(', ') };

    await this.webhookLogModel.create({
      source:      'pays2',
      headers:     headers ?? null,
      payload:     body,
      response,
      steps:       allSteps,
      status_code: 200,
      ip:          ip ?? '',
    });

    return response;
  }

  // ─── Lưu log lỗi (token sai, server lỗi...) ─────────────────────────────
  async saveErrorLog(body: any, headers?: Record<string, any>, ip?: string, error?: string): Promise<void> {
    try {
      await this.webhookLogModel.create({
        source:      'pays2',
        headers:     headers ?? null,
        payload:     body,
        response:    { success: false, message: error ?? 'Unknown error' },
        steps: [{
          step:   1,
          title:  'Hệ thống nhận webhook từ ngân hàng',
          detail: `Lỗi xác thực: ${error ?? 'Unknown error'}`,
          status: WebhookStepStatus.ERROR,
        }],
        status_code: 401,
        ip:          ip ?? '',
      });
    } catch { /* không được làm crash flow */ }
  }

  // ─── Admin: lấy webhook steps theo transaction MongoDB ID ────────────────
  async getStepsByTransactionId(mongoId: string) {
    const tx = await this.txModel
      .findById(mongoId)
      .select('transaction_id')
      .lean()
      .exec();

    if (!tx) return { steps: [], transaction_id: null };

    const numericId = (tx as any).transaction_id as number;

    const log = await this.webhookLogModel
      .findOne({ 'steps.data.transaction_id': numericId })
      .select('steps source ip status_code createdAt')
      .lean()
      .exec();

    if (!log) return { steps: [], transaction_id: numericId };

    // Lọc chỉ lấy steps thuộc transaction này
    const steps = (log.steps as any[]).filter(
      (s) => !s.data?.transaction_id || s.data.transaction_id === numericId,
    );

    return {
      steps,
      transaction_id: numericId,
      received_at:    (log as any).createdAt,
      source:         log.source,
      ip:             log.ip,
      status_code:    log.status_code,
    };
  }

  // ─── Admin: danh sách webhook log ────────────────────────────────────────
  async getWebhookLogs(page = 1, limit = 20, from_date?: string, to_date?: string) {
    const filter: any = {};
    if (from_date || to_date) {
      filter.createdAt = {};
      if (from_date) filter.createdAt.$gte = new Date(from_date + 'T00:00:00+07:00');
      if (to_date)   filter.createdAt.$lte = new Date(to_date   + 'T23:59:59.999+07:00');
    }
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.webhookLogModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('source ip payload response steps status_code createdAt')
        .exec(),
      this.webhookLogModel.countDocuments(filter),
    ]);

    return {
      data: data.map(log => ({
        _id:                log._id,
        source:             log.source,
        ip:                 log.ip,
        transactions_count: (log.payload as any)?.transactions?.length ?? 0,
        response:           log.response,
        steps:              log.steps,
        status_code:        log.status_code,
        received_at:        (log as any).createdAt,
      })),
      pagination: { total, page, limit, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── User: lịch sử nạp tiền của chính mình ───────────────────────────────
  async getUserTransactions(
    userId: string,
    page = 1,
    limit = 20,
    status?: string,
    from_date?: string,
    to_date?: string,
  ) {
    const filter: any = { user_id: new Types.ObjectId(userId), transfer_type: 'IN' };
    if (status) filter.status = status;
    if (from_date || to_date) {
      filter.createdAt = {};
      if (from_date) filter.createdAt.$gte = new Date(from_date + 'T00:00:00+07:00');
      if (to_date)   filter.createdAt.$lte = new Date(to_date   + 'T23:59:59.999+07:00');
    }
    const skip = (page - 1) * limit;

    const [data, total, totalAmount] = await Promise.all([
      this.txModel
        .find(filter)
        .select('transaction_id gateway transaction_date transfer_amount status source note createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.txModel.countDocuments(filter),
      this.txModel.aggregate([
        { $match: { user_id: new Types.ObjectId(userId), status: TransactionStatus.PROCESSED } },
        { $group: { _id: null, total: { $sum: '$transfer_amount' } } },
      ]),
    ]);

    return {
      data,
      total,
      page,
      limit,
      total_deposited: totalAmount[0]?.total ?? 0,
    };
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

  async getList(
    page = 1,
    limit = 20,
    status?: string,
    source?: string,
    from_date?: string,
    to_date?: string,
    gateway?: string,
    content?: string,
  ) {
    const filter: any = { transfer_type: 'IN' };
    if (status)  filter.status  = status;
    if (source)  filter.source  = source;
    if (gateway) filter.gateway = gateway.toUpperCase();
    if (content) filter.content = { $regex: content, $options: 'i' };
    if (from_date || to_date) {
      filter.transaction_date = {};
      if (from_date) filter.transaction_date.$gte = new Date(from_date + 'T00:00:00+07:00');
      if (to_date)   filter.transaction_date.$lte = new Date(to_date   + 'T23:59:59.999+07:00');
    }
    const skip = (page - 1) * limit;

    const [data, total, stats] = await Promise.all([
      this.txModel
        .find(filter)
        .populate('user_id', 'email name')
        .sort({ transaction_date: -1 })
        .skip(skip)
        .limit(limit)
        .select('transaction_date content transfer_amount gateway user_id status transaction_number account_number')
        .exec(),
      this.txModel.countDocuments(filter),
      this.txModel.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            total_amount:     { $sum: '$transfer_amount' },
            total_processed:  { $sum: { $cond: [{ $eq: ['$status', TransactionStatus.PROCESSED] }, 1, 0] } },
            total_unmatched:  { $sum: { $cond: [{ $eq: ['$status', TransactionStatus.UNMATCHED] }, 1, 0] } },
            amount_processed: { $sum: { $cond: [{ $eq: ['$status', TransactionStatus.PROCESSED] }, '$transfer_amount', 0] } },
          },
        },
      ]),
    ]);

    const s = stats[0] ?? { total_amount: 0, total_processed: 0, total_unmatched: 0, amount_processed: 0 };

    return {
      data: data.map(tx => ({
        _id:                tx._id,
        transaction_date:   tx.transaction_date,
        content:            tx.content,
        transfer_amount:    tx.transfer_amount,
        gateway:            tx.gateway,
        account_number:     tx.account_number,
        transaction_number: tx.transaction_number,
        recipient:          (tx.user_id as any)?.email ?? null,
        status:             tx.status,
      })),
      pagination: { total, page, limit, total_pages: Math.ceil(total / limit) },
      summary: {
        total_transactions: total,
        total_amount:       s.total_amount,
        total_processed:    s.total_processed,
        amount_processed:   s.amount_processed,
        total_unmatched:    s.total_unmatched,
      },
    };
  }

  // ─── Admin: duyệt giao dịch — cộng tiền ────────────────────────────────
  async approveTransaction(txId: string, email?: string, adminUserId?: string) {
    const tx = await this.txModel.findById(txId).exec();
    if (!tx) throw new BadRequestException('Không tìm thấy giao dịch');
    if (tx.status === TransactionStatus.PROCESSED) {
      throw new BadRequestException('Giao dịch đã được xử lý trước đó');
    }

    let user: UserDocument | null = null;

    // Ưu tiên 1: giao dịch đã match user_id sẵn
    if (tx.user_id) {
      user = await this.userModel.findById(tx.user_id).select('_id email money').exec();
    }

    // Ưu tiên 2: admin nhập email
    if (!user && email) {
      user = await this.userModel.findOne({ email }).select('_id email money').exec();
      if (!user) throw new BadRequestException('Không tìm thấy người dùng với email này');
    }

    // Ưu tiên 3: dùng admin đang đăng nhập
    if (!user && adminUserId) {
      user = await this.userModel.findById(adminUserId).select('_id email money').exec();
    }

    if (!user) {
      throw new BadRequestException('Cần nhập email để cộng tiền');
    }

    const amount = tx.transfer_amount;
    const balanceBefore = Number(user.money ?? 0);
    const balanceAfter = balanceBefore + amount;

    await this.userModel.findByIdAndUpdate(user._id, { $inc: { money: amount } }).exec();

    tx.status = TransactionStatus.PROCESSED;
    tx.user_id = user._id;
    tx.balance_before = balanceBefore;
    tx.balance_after = balanceAfter;
    tx.source = 'bank';
    tx.note = `Admin duyệt — nạp ${amount.toLocaleString('vi-VN')}đ cho ${user.email}`;
    await tx.save();

    this.notification.sendTopupSuccess(user._id.toString(), { amount, balance: balanceAfter });

    return {
      message: 'Duyệt giao dịch thành công',
      data: {
        _id: tx._id,
        status: tx.status,
        user_id: { _id: user._id, email: user.email },
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        transfer_amount: amount,
      },
    };
  }

  // ─── Admin: huỷ giao dịch ─────────────────────────────────────────────
  async rejectTransaction(txId: string, note?: string) {
    const tx = await this.txModel.findById(txId).exec();
    if (!tx) throw new BadRequestException('Giao dịch không tồn tại');
    if (tx.status === TransactionStatus.PROCESSED) {
      throw new BadRequestException('Không thể huỷ giao dịch đã xử lý');
    }
    if (tx.status === TransactionStatus.REJECTED) {
      throw new BadRequestException('Giao dịch đã bị huỷ');
    }

    tx.status = TransactionStatus.REJECTED;
    tx.note = note || 'Admin huỷ giao dịch';
    await tx.save();

    return { message: 'Đã huỷ giao dịch', transaction: tx };
  }

  // ─── User: dashboard ────────────────────────────────────────────────────
  async getUserDashboard(userId: string) {
    const uid = new Types.ObjectId(userId);

    const [user, activeProxies, totalDeposited, totalOrders] = await Promise.all([
      this.userModel.findById(uid).select('money email name topup_code').exec(),
      this.orderModel.countDocuments({ user_id: uid, status: OrderStatusEnum.ACTIVE }),
      this.txModel.aggregate([
        { $match: { user_id: uid, status: TransactionStatus.PROCESSED, transfer_type: 'IN' } },
        { $group: { _id: null, total: { $sum: '$transfer_amount' } } },
      ]),
      this.orderModel.countDocuments({ user_id: uid }),
    ]);

    return {
      balance: user?.money ?? 0,
      active_proxies: activeProxies,
      total_deposited: totalDeposited[0]?.total ?? 0,
      total_orders: totalOrders,
    };
  }

  // ─── Admin: dashboard ───────────────────────────────────────────────────
  async getAdminDashboard() {
    const now = new Date();

    // Đầu ngày hôm nay (UTC+7)
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    // Đầu tháng này
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // 30 ngày trước
    const days30Ago = new Date(now);
    days30Ago.setDate(days30Ago.getDate() - 29);
    days30Ago.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      newUsersToday,
      newUsersThisMonth,
      totalRevenue,
      revenueToday,
      revenueThisMonth,
      totalDeposits,
      pendingDeposits,
      unmatchedDeposits,
      totalOrders,
      activeOrders,
      expiredOrders,
      revenueChart,
      recentDeposits,
      recentOrders,
      recentUsers,
      topUsers,
    ] = await Promise.all([
      // ── Stats ──
      this.userModel.countDocuments(),
      this.userModel.countDocuments({ createdAt: { $gte: startOfToday } }),
      this.userModel.countDocuments({ createdAt: { $gte: startOfMonth } }),
      this.txModel.aggregate([
        { $match: { status: TransactionStatus.PROCESSED, transfer_type: 'IN' } },
        { $group: { _id: null, total: { $sum: '$transfer_amount' } } },
      ]),
      this.txModel.aggregate([
        { $match: { status: TransactionStatus.PROCESSED, transfer_type: 'IN', createdAt: { $gte: startOfToday } } },
        { $group: { _id: null, total: { $sum: '$transfer_amount' } } },
      ]),
      this.txModel.aggregate([
        { $match: { status: TransactionStatus.PROCESSED, transfer_type: 'IN', createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: '$transfer_amount' } } },
      ]),
      this.txModel.countDocuments({ transfer_type: 'IN' }),
      this.txModel.countDocuments({ status: TransactionStatus.PENDING }),
      this.txModel.countDocuments({ status: TransactionStatus.UNMATCHED }),
      this.orderModel.countDocuments(),
      this.orderModel.countDocuments({ status: OrderStatusEnum.ACTIVE }),
      this.orderModel.countDocuments({ status: OrderStatusEnum.EXPIRED }),

      // ── Revenue chart 30 ngày ──
      this.txModel.aggregate([
        {
          $match: {
            status: TransactionStatus.PROCESSED,
            transfer_type: 'IN',
            createdAt: { $gte: days30Ago },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+07:00' } },
            revenue: { $sum: '$transfer_amount' },
            deposits: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // ── Recent deposits (5) ──
      this.txModel
        .find({ transfer_type: 'IN' })
        .populate('user_id', 'email name')
        .select('transaction_id gateway transfer_amount content status createdAt')
        .sort({ createdAt: -1 })
        .limit(5)
        .exec(),

      // ── Recent orders (5) ──
      this.orderModel
        .find()
        .populate('user_id', 'email name')
        .populate('service_id', 'name')
        .select('order_code total_price status createdAt')
        .sort({ createdAt: -1 })
        .limit(5)
        .exec(),

      // ── Recent users (5) ──
      this.userModel
        .find()
        .select('name email money status createdAt')
        .sort({ createdAt: -1 })
        .limit(5)
        .exec(),

      // ── Top 5 users by spending ──
      this.orderModel.aggregate([
        { $match: { status: { $in: [OrderStatusEnum.ACTIVE, OrderStatusEnum.COMPLETED, OrderStatusEnum.EXPIRED] } } },
        {
          $group: {
            _id: '$user_id',
            total_spent: { $sum: '$total_price' },
            total_orders: { $sum: 1 },
          },
        },
        { $sort: { total_spent: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'user',
          },
        },
        { $unwind: '$user' },
        {
          $project: {
            _id: '$user._id',
            name: '$user.name',
            email: '$user.email',
            money: '$user.money',
            total_spent: 1,
            total_orders: 1,
          },
        },
      ]),
    ]);

    // Fill missing days in revenue chart
    const chartMap = new Map<string, { revenue: number; deposits: number }>();
    for (const item of revenueChart) {
      chartMap.set(item._id, { revenue: item.revenue, deposits: item.deposits });
    }
    const filledChart: { date: string; revenue: number; deposits: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(days30Ago);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      filledChart.push({
        date: key,
        revenue: chartMap.get(key)?.revenue ?? 0,
        deposits: chartMap.get(key)?.deposits ?? 0,
      });
    }

    // Format recent orders
    const formattedOrders = recentOrders.map((o: any) => ({
      _id: o._id,
      order_code: o.order_code,
      user_id: o.user_id,
      service_name: o.service_id?.name ?? '',
      amount: o.total_price,
      status: o.status,
      createdAt: o.createdAt,
    }));

    return {
      stats: {
        total_users: totalUsers,
        new_users_today: newUsersToday,
        new_users_this_month: newUsersThisMonth,
        total_revenue: totalRevenue[0]?.total ?? 0,
        revenue_today: revenueToday[0]?.total ?? 0,
        revenue_this_month: revenueThisMonth[0]?.total ?? 0,
        total_deposits: totalDeposits,
        pending_deposits: pendingDeposits,
        unmatched_deposits: unmatchedDeposits,
        total_orders: totalOrders,
        active_orders: activeOrders,
        expired_orders: expiredOrders,
      },
      revenue_chart: filledChart,
      recent_deposits: recentDeposits,
      recent_orders: formattedOrders,
      recent_users: recentUsers,
      top_users: topUsers,
    };
  }
}
