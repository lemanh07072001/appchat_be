import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  WalletTransaction,
  WalletTransactionDocument,
  WalletTxType,
} from '../schemas/wallet-transaction.schema';

export interface LogWalletTxParams {
  user_id: string | Types.ObjectId;
  type: WalletTxType;
  amount: number;
  direction: 'in' | 'out';
  balance_before: number;
  balance_after: number;
  description: string;
  ref_id?: string | null;
  ref_type?: string | null;
  created_by?: string;
}

@Injectable()
export class WalletTransactionService {
  private readonly logger = new Logger(WalletTransactionService.name);

  constructor(
    @InjectModel(WalletTransaction.name)
    private readonly model: Model<WalletTransactionDocument>,
  ) {}

  /** Ghi 1 bản ghi vào lịch sử ví — không throw, lỗi chỉ log */
  async log(params: LogWalletTxParams): Promise<void> {
    try {
      await this.model.create({
        user_id:        new Types.ObjectId(params.user_id.toString()),
        type:           params.type,
        amount:         params.amount,
        direction:      params.direction,
        balance_before: params.balance_before,
        balance_after:  params.balance_after,
        description:    params.description,
        ref_id:         params.ref_id   ?? null,
        ref_type:       params.ref_type ?? null,
        created_by:     params.created_by ?? 'system',
      });
    } catch (err: any) {
      this.logger.error(`WalletTransaction log failed: ${err?.message}`, err?.stack);
    }
  }

  /** Lịch sử ví của 1 user — phân trang */
  async findByUser(
    userId: string,
    page = 1,
    limit = 20,
    type?: WalletTxType,
  ) {
    const filter: any = { user_id: new Types.ObjectId(userId) };
    if (type) filter.type = type;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Lịch sử ví tất cả user — cho admin */
  async findAll(
    page = 1,
    limit = 20,
    userId?: string,
    type?: WalletTxType,
  ) {
    const filter: any = {};
    if (userId) filter.user_id = new Types.ObjectId(userId);
    if (type)   filter.type   = type;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user_id', 'email username')
        .lean()
        .exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
