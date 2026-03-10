import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AffiliateCommission,
  AffiliateCommissionDocument,
  AffiliateCommissionStatus,
} from '../schemas/affiliate-commission.schema';
import {
  AffiliateConfig,
  AffiliateConfigDocument,
} from '../schemas/affiliate-config.schema';
import { User, UserDocument } from '../schemas/users.schema';
import { OrderDocument } from '../schemas/orders.schema';
import { Withdrawal, WithdrawalDocument, WithdrawalStatus } from '../schemas/withdrawal.schema';
import { PaginationQueryDto } from '../dto/pagination-query.dto';

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(
    @InjectModel(AffiliateCommission.name)
    private commissionModel: Model<AffiliateCommissionDocument>,
    @InjectModel(AffiliateConfig.name)
    private configModel: Model<AffiliateConfigDocument>,
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
    @InjectModel(Withdrawal.name)
    private withdrawalModel: Model<WithdrawalDocument>,
  ) {}

  // ─── Gọi khi order → ACTIVE: ghi nhận commission PENDING, chưa cộng tiền ──
  async handleOrderActive(order: OrderDocument): Promise<void> {
    try {
      const config = await this.getConfig();
      if (!config.is_active) return;

      const buyer = await this.userModel
        .findById(order.user_id)
        .select('referred_by')
        .lean()
        .exec();

      if (!buyer?.referred_by) return;

      const commissionAmount = parseFloat(
        ((order.total_price * config.commission_rate) / 100).toFixed(2),
      );

      if (commissionAmount <= 0) return;

      // Tạo commission PENDING — chưa cộng tiền, chờ order hoàn thành
      const commission = new this.commissionModel({
        referrer_id:       buyer.referred_by,
        referred_user_id:  order.user_id,
        order_id:          order._id,
        order_total:       order.total_price,
        commission_rate:   config.commission_rate,
        commission_amount: commissionAmount,
        status:            AffiliateCommissionStatus.PENDING,
      });

      await commission.save();

      this.logger.log(
        `Affiliate PENDING: order ${order._id} → ${commissionAmount} chờ hoàn thành`,
      );
    } catch (err: any) {
      if (err?.code === 11000) return; // idempotent
      this.logger.error(`handleOrderActive error: ${err?.message}`);
    }
  }

  // ─── Gọi khi orders → EXPIRED: chuyển PENDING → CONFIRMED (đủ điều kiện rút) ─
  async handleOrderExpired(orderIds: Types.ObjectId[]): Promise<void> {
    if (orderIds.length === 0) return;
    try {
      const result = await this.commissionModel.updateMany(
        { order_id: { $in: orderIds }, status: AffiliateCommissionStatus.PENDING },
        { status: AffiliateCommissionStatus.CONFIRMED, confirmed_at: new Date() },
      ).exec();

      if (result.modifiedCount > 0) {
        this.logger.log(`Affiliate: ${result.modifiedCount} commission(s) → CONFIRMED`);
      }
    } catch (err: any) {
      this.logger.error(`handleOrderExpired error: ${err?.message}`);
    }
  }

  // ─── Admin: duyệt commission CONFIRMED → CREDITED + cộng affiliate_balance ──
  async creditCommission(commissionId: string): Promise<{ credited: number }> {
    // Atomic: findOneAndUpdate với filter status=CONFIRMED → chỉ 1 request thành công dù admin click nhanh
    const commission = await this.commissionModel.findOneAndUpdate(
      { _id: new Types.ObjectId(commissionId), status: AffiliateCommissionStatus.CONFIRMED },
      { status: AffiliateCommissionStatus.CREDITED, credited_at: new Date() },
      { new: false }, // trả về doc cũ để lấy amount
    ).exec();

    if (!commission) {
      throw new BadRequestException('Không tìm thấy commission đủ điều kiện để duyệt');
    }

    const amount = commission.commission_amount;

    await this.userModel.findByIdAndUpdate(commission.referrer_id, {
      $inc: { affiliate_balance: amount },
    }).exec();

    this.logger.log(`Affiliate credited: commission ${commissionId} → +${amount} vào affiliate_balance`);
    return { credited: amount };
  }

  // ─── Bước 1 — User: gửi yêu cầu rút về ngân hàng ───────────────────────
  async requestWithdraw(userId: string, commissionId: string): Promise<{ message: string }> {
    const user = await this.userModel.findById(userId).select('bank_name bank_account bank_owner').lean().exec();

    if (!user?.bank_account) {
      throw new BadRequestException('Vui lòng cập nhật thông tin ngân hàng trước khi rút');
    }

    // Atomic: chỉ update nếu status đúng là CREDITED → chặn race condition
    const updated = await this.commissionModel.findOneAndUpdate(
      {
        _id:         new Types.ObjectId(commissionId),
        referrer_id: new Types.ObjectId(userId),
        status:      AffiliateCommissionStatus.CREDITED,
      },
      {
        status:       AffiliateCommissionStatus.REQUESTED,
        requested_at: new Date(),
        bank_name:    user.bank_name,
        bank_account: user.bank_account,
        bank_owner:   user.bank_owner,
      },
    ).exec();

    if (!updated) {
      // Tìm lại để trả về thông báo lỗi chính xác
      const existing = await this.commissionModel
        .findOne({ _id: new Types.ObjectId(commissionId), referrer_id: new Types.ObjectId(userId) })
        .select('status').lean().exec();

      if (!existing) throw new BadRequestException('Commission không tồn tại');
      if (existing.status === AffiliateCommissionStatus.PENDING)   throw new BadRequestException('Đơn hàng chưa hoàn thành, chưa thể yêu cầu rút');
      if (existing.status === AffiliateCommissionStatus.CONFIRMED) throw new BadRequestException('Hoa hồng chưa được admin duyệt vào ví, vui lòng chờ');
      if (existing.status === AffiliateCommissionStatus.REQUESTED) throw new BadRequestException('Yêu cầu rút đã được gửi, đang chờ admin chuyển khoản');
      throw new BadRequestException('Commission không đủ điều kiện để yêu cầu rút');
    }

    // Atomic: trừ affiliate_balance chỉ khi đủ tiền
    const deducted = await this.userModel.findOneAndUpdate(
      { _id: new Types.ObjectId(userId), affiliate_balance: { $gte: updated.commission_amount } },
      { $inc: { affiliate_balance: -updated.commission_amount } },
      { new: true },
    ).exec();

    if (!deducted) {
      // Rollback commission status về CREDITED
      await this.commissionModel.findByIdAndUpdate(updated._id, {
        status: AffiliateCommissionStatus.CREDITED,
        requested_at: null,
      }).exec();
      throw new BadRequestException('Số dư ví affiliate không đủ');
    }

    await this.withdrawalModel.create({
      user_id:        new Types.ObjectId(userId),
      total_amount:   updated.commission_amount,
      bank_name:      user.bank_name,
      bank_account:   user.bank_account,
      bank_owner:     user.bank_owner,
      status:         WithdrawalStatus.REQUESTED,
      commission_ids: [new Types.ObjectId(commissionId)],
      requested_at:   new Date(),
    });

    this.logger.log(`Affiliate: user ${userId} yêu cầu rút commission ${commissionId} → ${user.bank_account}`);
    return { message: 'Yêu cầu rút đã được gửi, chờ admin chuyển khoản' };
  }

  // ─── User: rút toàn bộ số dư affiliate_balance về ngân hàng ─────────────
  async requestWithdrawAll(
    userId: string,
    bankInfo?: { bank_name?: string; bank_account?: string; bank_owner?: string },
  ): Promise<{ message: string; total: number }> {
    // Nếu truyền bank info mới thì lưu lại trước
    if (bankInfo?.bank_account) {
      await this.userModel.findByIdAndUpdate(userId, {
        bank_name:    bankInfo.bank_name    ?? '',
        bank_account: bankInfo.bank_account,
        bank_owner:   bankInfo.bank_owner   ?? '',
      }).exec();
    }

    const user = await this.userModel
      .findById(userId)
      .select('bank_name bank_account bank_owner affiliate_balance')
      .lean()
      .exec();

    if (!user?.bank_account) {
      throw new BadRequestException('Vui lòng cập nhật thông tin ngân hàng trước khi rút');
    }
    if (!user.affiliate_balance || user.affiliate_balance <= 0) {
      throw new BadRequestException('Số dư ví affiliate bằng 0, không có gì để rút');
    }

    const hasPending = await this.commissionModel.exists({
      referrer_id: new Types.ObjectId(userId),
      status:      AffiliateCommissionStatus.REQUESTED,
    });
    if (hasPending) {
      throw new BadRequestException('Bạn đã có yêu cầu rút đang chờ xử lý');
    }

    // Lấy danh sách commission CREDITED để ghi vào withdrawal record
    const creditedCommissions = await this.commissionModel
      .find({ referrer_id: new Types.ObjectId(userId), status: AffiliateCommissionStatus.CREDITED })
      .select('_id')
      .lean()
      .exec();

    if (creditedCommissions.length === 0) {
      throw new BadRequestException('Không có hoa hồng nào đã được duyệt vào ví, vui lòng chờ admin duyệt');
    }

    const commissionIds = creditedCommissions.map(c => c._id as Types.ObjectId);
    const now = new Date();

    await this.commissionModel.updateMany(
      { referrer_id: new Types.ObjectId(userId), status: AffiliateCommissionStatus.CREDITED },
      {
        status:       AffiliateCommissionStatus.REQUESTED,
        requested_at: now,
        bank_name:    user.bank_name,
        bank_account: user.bank_account,
        bank_owner:   user.bank_owner,
      },
    ).exec();

    // Atomic: trừ affiliate_balance chỉ khi đủ tiền
    const withdrawAmount = user.affiliate_balance;
    const deducted = await this.userModel.findOneAndUpdate(
      { _id: new Types.ObjectId(userId), affiliate_balance: { $gte: withdrawAmount } },
      { $inc: { affiliate_balance: -withdrawAmount } },
      { new: true },
    ).exec();

    if (!deducted) {
      // Rollback commissions về CREDITED
      await this.commissionModel.updateMany(
        { _id: { $in: commissionIds }, status: AffiliateCommissionStatus.REQUESTED },
        { status: AffiliateCommissionStatus.CREDITED, requested_at: null },
      ).exec();
      throw new BadRequestException('Số dư ví affiliate không đủ');
    }

    await this.withdrawalModel.create({
      user_id:        new Types.ObjectId(userId),
      total_amount:   withdrawAmount,
      bank_name:      user.bank_name,
      bank_account:   user.bank_account,
      bank_owner:     user.bank_owner,
      status:         WithdrawalStatus.REQUESTED,
      commission_ids: commissionIds,
      requested_at:   now,
    });

    this.logger.log(`Affiliate: user ${userId} yêu cầu rút ${withdrawAmount} → ${user.bank_account}`);
    return { message: 'Yêu cầu rút đã được gửi, chờ admin chuyển khoản', total: withdrawAmount };
  }

  private validateObjectId(id: string, label = 'ID') {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`${label} không hợp lệ`);
  }

  // ─── Admin: xác nhận đã chuyển khoản → PAID ────────────────────────────
  async approveWithdraw(withdrawalId: string): Promise<{ amount: number }> {
    this.validateObjectId(withdrawalId, 'Withdrawal ID');
    const existing = await this.withdrawalModel.findById(withdrawalId).lean().exec();
    if (!existing) throw new BadRequestException('Không tìm thấy yêu cầu rút');
    if (existing.status === WithdrawalStatus.PAID)     throw new BadRequestException('Yêu cầu này đã được duyệt trước đó');
    if (existing.status === WithdrawalStatus.REJECTED) throw new BadRequestException('Yêu cầu này đã bị từ chối, không thể duyệt');

    const withdrawal = await this.withdrawalModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(withdrawalId), status: WithdrawalStatus.REQUESTED },
        { status: WithdrawalStatus.PAID, paid_at: new Date() },
        { new: true },
      )
      .exec();

    if (!withdrawal) {
      throw new BadRequestException('Không tìm thấy yêu cầu rút hợp lệ');
    }

    // Cập nhật tất cả commissions trong lần rút này → PAID
    await this.commissionModel.updateMany(
      { _id: { $in: withdrawal.commission_ids }, status: AffiliateCommissionStatus.REQUESTED },
      { status: AffiliateCommissionStatus.PAID, paid_at: new Date() },
    ).exec();

    // Tiền đã bị trừ khi user gửi yêu cầu rút, không cần trừ lại ở đây
    this.logger.log(`Affiliate paid: withdrawal ${withdrawalId} → ${withdrawal.total_amount} → ${withdrawal.bank_account}`);
    return { amount: withdrawal.total_amount };
  }

  // ─── Admin: từ chối yêu cầu → trả về CREDITED + hoàn lại balance ─────────
  async rejectWithdraw(withdrawalId: string): Promise<{ message: string }> {
    this.validateObjectId(withdrawalId, 'Withdrawal ID');
    const existing = await this.withdrawalModel.findById(withdrawalId).lean().exec();
    if (!existing) throw new BadRequestException('Không tìm thấy yêu cầu rút');
    if (existing.status === WithdrawalStatus.PAID)     throw new BadRequestException('Yêu cầu này đã được duyệt, không thể từ chối');
    if (existing.status === WithdrawalStatus.REJECTED) throw new BadRequestException('Yêu cầu này đã bị từ chối trước đó');

    const withdrawal = await this.withdrawalModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(withdrawalId), status: WithdrawalStatus.REQUESTED },
        { status: WithdrawalStatus.REJECTED, rejected_at: new Date() },
        { new: true },
      )
      .exec();

    if (!withdrawal) {
      throw new BadRequestException('Không tìm thấy yêu cầu rút hợp lệ');
    }

    // Trả commissions về CREDITED
    await this.commissionModel.updateMany(
      { _id: { $in: withdrawal.commission_ids }, status: AffiliateCommissionStatus.REQUESTED },
      { status: AffiliateCommissionStatus.CREDITED, requested_at: null },
    ).exec();

    // Hoàn lại affiliate_balance
    await this.userModel.findByIdAndUpdate(withdrawal.user_id, {
      $inc: { affiliate_balance: withdrawal.total_amount },
    }).exec();

    this.logger.log(`Affiliate rejected: withdrawal ${withdrawalId}, hoàn lại ${withdrawal.total_amount}`);
    return { message: 'Đã từ chối yêu cầu rút' };
  }

  // ─── Gọi khi user mới đăng ký: tạo referral_code + gán referred_by ────────
  async initNewUser(userId: string, refCode?: string): Promise<void> {
    const code = await this.generateUniqueCode();
    await this.userModel.findByIdAndUpdate(userId, { referral_code: code }).exec();
    if (refCode) {
      await this.applyReferralCode(userId, refCode);
    }
  }

  // ─── Gán referred_by khi user đăng ký bằng referral code ─────────────────
  async applyReferralCode(userId: string, code: string): Promise<void> {
    if (!code) return;

    this.logger.log(`applyReferralCode: userId=${userId}, code=${code}`);

    const referrer = await this.userModel
      .findOne({ referral_code: code })
      .select('_id')
      .lean()
      .exec();

    if (!referrer) {
      this.logger.warn(`applyReferralCode: không tìm thấy referrer với code=${code}`);
      return;
    }

    if (referrer._id.toString() === userId) {
      this.logger.warn(`applyReferralCode: user tự giới thiệu chính mình`);
      return;
    }

    await this.userModel.findByIdAndUpdate(userId, {
      referred_by: referrer._id,
    }).exec();

    this.logger.log(`applyReferralCode: user ${userId} được giới thiệu bởi ${referrer._id}`);
  }

  // ─── Lấy link affiliate (tạo code nếu chưa có) ───────────────────────────
  // ─── Cập nhật thông tin ngân hàng ────────────────────────────────────────
  async updateBankInfo(userId: string, dto: { bank_name: string; bank_account: string; bank_owner: string }) {
    await this.userModel.findByIdAndUpdate(userId, {
      bank_name:    dto.bank_name,
      bank_account: dto.bank_account,
      bank_owner:   dto.bank_owner,
    }).exec();
    return { message: 'Cập nhật thông tin ngân hàng thành công' };
  }

  async getMyLink(userId: string): Promise<{ id: unknown; code: string; link: string; commission_rate: number }> {
    const [user_, config] = await Promise.all([
      this.userModel.findById(userId).select('referral_code').exec(),
      this.getConfig(),
    ]);

    if (!user_) throw new BadRequestException('User không tồn tại');

    let user = user_;
    if (!user.referral_code) {
      const code = await this.generateUniqueCode();
      const updated = await this.userModel.findByIdAndUpdate(
        userId,
        { referral_code: code },
        { new: true },
      ).exec();
      if (!updated) throw new BadRequestException('User không tồn tại');
      user = updated;
    }

    return {
      id:              user._id,
      code:            user.referral_code,
      link:            `/register?ref=${user.referral_code}`,
      commission_rate: config.commission_rate,
    };
  }

  // ─── Thống kê affiliate của user ─────────────────────────────────────────
  async getStats(userId: string) {
    const objectId = new Types.ObjectId(userId);

    const [totalReferred, commissionStats, user] = await Promise.all([
      this.userModel.countDocuments({ referred_by: objectId }).exec(),
      this.commissionModel.aggregate([
        { $match: { referrer_id: objectId, status: { $ne: AffiliateCommissionStatus.CANCELLED } } },
        {
          $group: {
            _id: null,
            total_orders: { $sum: 1 },
            // PENDING: đơn đang active, chưa hết hạn
            pending_amount: {
              $sum: { $cond: [{ $eq: ['$status', AffiliateCommissionStatus.PENDING] }, '$commission_amount', 0] },
            },
            // CONFIRMED: đơn đã hết hạn, chờ admin credit vào ví
            awaiting_credit: {
              $sum: { $cond: [{ $eq: ['$status', AffiliateCommissionStatus.CONFIRMED] }, '$commission_amount', 0] },
            },
            // CREDITED: đã vào ví, chưa rút
            credited_amount: {
              $sum: { $cond: [{ $eq: ['$status', AffiliateCommissionStatus.CREDITED] }, '$commission_amount', 0] },
            },
            // REQUESTED: đã gửi yêu cầu rút, chờ admin chuyển khoản
            requested_amount: {
              $sum: { $cond: [{ $eq: ['$status', AffiliateCommissionStatus.REQUESTED] }, '$commission_amount', 0] },
            },
            // PAID: đã nhận tiền
            paid_amount: {
              $sum: { $cond: [{ $eq: ['$status', AffiliateCommissionStatus.PAID] }, '$commission_amount', 0] },
            },
          },
        },
      ]).exec(),
      this.userModel.findById(userId).select('affiliate_balance referral_code').lean().exec(),
    ]);

    const s = commissionStats[0] ?? {
      total_orders:     0,
      pending_amount:   0,
      awaiting_credit:  0,
      credited_amount:  0,
      requested_amount: 0,
      paid_amount:      0,
    };

    // total_earned = tất cả đã được xác nhận (trừ PENDING vì đơn chưa hết hạn)
    const total_earned = s.awaiting_credit + s.credited_amount + s.requested_amount + s.paid_amount;

    return {
      referral_code:     user?.referral_code   ?? '',
      affiliate_balance: user?.affiliate_balance ?? 0, // CREDITED còn trong ví
      total_referred:    totalReferred,
      total_orders:      s.total_orders,
      total_earned,                                     // đã xác nhận (không tính pending)
      pending_amount:    s.pending_amount,              // đơn active, chờ hết hạn
      awaiting_credit:   s.awaiting_credit,             // chờ admin credit vào ví
      requested_amount:  s.requested_amount,            // đang chờ admin chuyển khoản
      paid_amount:       s.paid_amount,                 // đã nhận tiền
    };
  }

  // ─── Admin: tất cả commission (filter theo status tuỳ chọn) ─────────────
  async getAllCommissions(query: PaginationQueryDto & { status?: string }) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;

    const filter: any = {};
    if (query.status) filter.status = query.status;

    const [data, total] = await Promise.all([
      this.commissionModel
        .find(filter)
        .populate('referrer_id', 'name email')
        .populate('referred_user_id', 'name email')
        .populate('order_id', 'order_code total_price createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.commissionModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Admin: danh sách tất cả giao dịch rút (filter theo status nếu có) ───
  async getWithdrawRequests(query: PaginationQueryDto & { status?: string }) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;

    const filter: Record<string, any> = {};
    if (query.status) filter.status = query.status;

    const [data, total] = await Promise.all([
      this.withdrawalModel
        .find(filter)
        .populate('user_id', 'name email')
        .sort({ requested_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.withdrawalModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Danh sách hoa hồng (phân trang) ─────────────────────────────────────
  async getCommissions(userId: string, query: PaginationQueryDto) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;

    const filter: any = { referrer_id: new Types.ObjectId(userId) };
    if ((query as any).status) filter.status = (query as any).status;

    const [data, total] = await Promise.all([
      this.commissionModel
        .find(filter)
        .populate('referred_user_id', 'name email')
        .populate('order_id', 'order_code total_price createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.commissionModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── User: lịch sử yêu cầu rút ──────────────────────────────────────────
  async getMyWithdrawals(userId: string, query: PaginationQueryDto) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;

    const filter = { user_id: new Types.ObjectId(userId) };

    const [data, total] = await Promise.all([
      this.withdrawalModel
        .find(filter)
        .select('total_amount status bank_name bank_account bank_owner requested_at paid_at rejected_at commission_ids')
        .sort({ requested_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.withdrawalModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Admin: lấy / cập nhật config ────────────────────────────────────────
  async getConfig(): Promise<AffiliateConfigDocument> {
    let config = await this.configModel.findOne().exec();
    if (!config) {
      config = new this.configModel({ commission_rate: 5, is_active: true });
      await config.save();
    }
    return config;
  }

  async updateConfig(dto: { commission_rate?: number; is_active?: boolean }) {
    if (dto.commission_rate !== undefined) {
      if (dto.commission_rate <= 0 || dto.commission_rate > 100) {
        throw new BadRequestException('commission_rate phải trong khoảng 0.01 – 100');
      }
    }
    const config = await this.getConfig();
    if (dto.commission_rate !== undefined) config.commission_rate = dto.commission_rate;
    if (dto.is_active       !== undefined) config.is_active       = dto.is_active;
    return config.save();
  }

  // ─── Helper: tạo referral code duy nhất ──────────────────────────────────
  private async generateUniqueCode(): Promise<string> {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let code: string;
    do {
      const rand = Array.from(
        { length: 8 },
        () => chars[Math.floor(Math.random() * chars.length)],
      ).join('');
      code = `REF_${rand}`;
    } while (await this.userModel.findOne({ referral_code: code }).lean().exec());
    return code;
  }
}
