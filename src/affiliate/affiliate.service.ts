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
  ) {}

  // ─── Gọi khi order → ACTIVE (proxy đã được cấp phát thành công) ───────────
  async handleOrderActive(order: OrderDocument): Promise<void> {
    try {
      const config = await this.getConfig();
      if (!config.is_active) return;

      // Lấy referred_by của người mua
      const buyer = await this.userModel
        .findById(order.user_id)
        .select('referred_by')
        .lean()
        .exec();

      if (!buyer?.referred_by) return; // Không được giới thiệu → bỏ qua

      const commissionAmount = parseFloat(
        ((order.total_price * config.commission_rate) / 100).toFixed(2),
      );

      if (commissionAmount <= 0) return;

      // Tạo commission — unique index trên order_id đảm bảo idempotent
      const commission = new this.commissionModel({
        referrer_id:      buyer.referred_by,
        referred_user_id: order.user_id,
        order_id:         order._id,
        order_total:      order.total_price,
        commission_rate:  config.commission_rate,
        commission_amount: commissionAmount,
        status:           AffiliateCommissionStatus.CONFIRMED,
        confirmed_at:     new Date(),
      });

      await commission.save();

      // Cộng vào affiliate_balance của người giới thiệu
      await this.userModel.findByIdAndUpdate(buyer.referred_by, {
        $inc: { affiliate_balance: commissionAmount },
      }).exec();

      // Cập nhật status → PAID (balance đã được cộng)
      await this.commissionModel.findByIdAndUpdate(commission._id, {
        status: AffiliateCommissionStatus.PAID,
        paid_at: new Date(),
      }).exec();

      this.logger.log(
        `Affiliate: order ${order._id} → +${commissionAmount} cho referrer ${buyer.referred_by}`,
      );
    } catch (err: any) {
      // Bỏ qua lỗi duplicate key (E11000) — commission đã tạo trước đó
      if (err?.code === 11000) return;
      this.logger.error(`handleOrderActive error: ${err?.message}`);
    }
  }

  // ─── Gán referred_by khi user đăng ký bằng referral code ─────────────────
  async applyReferralCode(userId: string, code: string): Promise<void> {
    if (!code) return;

    const referrer = await this.userModel
      .findOne({ referral_code: code })
      .select('_id')
      .lean()
      .exec();

    if (!referrer) return; // Code không hợp lệ → bỏ qua

    // Không tự giới thiệu chính mình
    if (referrer._id.toString() === userId) return;

    await this.userModel.findByIdAndUpdate(userId, {
      referred_by: referrer._id,
    }).exec();
  }

  // ─── Lấy link affiliate (tạo code nếu chưa có) ───────────────────────────
  async getMyLink(userId: string): Promise<{ code: string; link: string }> {
    let user = await this.userModel
      .findById(userId)
      .select('referral_code')
      .exec();

    if (!user) throw new BadRequestException('User không tồn tại');

    if (!user.referral_code) {
      const code = await this.generateUniqueCode();
      user = await this.userModel.findByIdAndUpdate(
        userId,
        { referral_code: code },
        { new: true },
      ).exec();
    }

    return {
      code: user.referral_code,
      link: `/register?ref=${user.referral_code}`,
    };
  }

  // ─── Thống kê affiliate của user ─────────────────────────────────────────
  async getStats(userId: string) {
    const objectId = new Types.ObjectId(userId);

    const [totalReferred, commissionStats, user] = await Promise.all([
      this.userModel.countDocuments({ referred_by: objectId }).exec(),
      this.commissionModel.aggregate([
        { $match: { referrer_id: objectId } },
        {
          $group: {
            _id: null,
            total_earned:    { $sum: '$commission_amount' },
            total_confirmed: {
              $sum: {
                $cond: [{ $eq: ['$status', AffiliateCommissionStatus.CONFIRMED] }, '$commission_amount', 0],
              },
            },
            total_orders: { $sum: 1 },
          },
        },
      ]).exec(),
      this.userModel.findById(userId).select('affiliate_balance referral_code').lean().exec(),
    ]);

    const stats = commissionStats[0] ?? { total_earned: 0, total_confirmed: 0, total_orders: 0 };

    return {
      referral_code:    user?.referral_code ?? '',
      affiliate_balance: user?.affiliate_balance ?? 0,
      total_referred:   totalReferred,
      total_orders:     stats.total_orders,
      total_earned:     stats.total_earned,
      pending_balance:  stats.total_confirmed,
    };
  }

  // ─── Danh sách hoa hồng (phân trang) ─────────────────────────────────────
  async getCommissions(userId: string, query: PaginationQueryDto) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;

    const filter: any = { referrer_id: new Types.ObjectId(userId) };

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

  // ─── Chuyển affiliate_balance → money (balance chính) ────────────────────
  async transferToBalance(userId: string) {
    // Pipeline update: đọc + ghi trong 1 atomic operation → không thể race condition
    const before = await this.userModel.findOneAndUpdate(
      { _id: new Types.ObjectId(userId), affiliate_balance: { $gt: 0 } },
      [{ $set: {
        money:             { $add: ['$money', '$affiliate_balance'] },
        affiliate_balance: 0,
      }}],
      { new: false }, // trả về doc TRƯỚC khi update để lấy affiliate_balance cũ
    ).exec();

    if (!before) {
      throw new BadRequestException('Không có số dư hoa hồng để chuyển');
    }

    return { transferred: before.affiliate_balance };
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
