import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DailyUserStat,
  DailyUserStatDocument,
} from '../schemas/daily-user-stat.schema';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';

const VN_OFFSET = 7 * 3600000;
const BULK_CHUNK = 500;

/** 'YYYY-MM-DD' (ngày UTC+7) → timestamp 00:00 UTC+7 */
export function dayKeyToTimestamp(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1) - VN_OFFSET);
}

/** Đơn đã thanh toán & hợp lệ — đúng definition của admin dashboard / getFinance */
const IS_VALID_PAID = {
  $and: [
    { $eq: ['$payment_status', PaymentStatusEnum.PAID] },
    {
      $not: [
        {
          $in: [
            '$status',
            [
              OrderStatusEnum.PENDING,
              OrderStatusEnum.CANCELLED,
              OrderStatusEnum.FAILED,
              OrderStatusEnum.REFUNDED,
            ],
          ],
        },
      ],
    },
  ],
};

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);

  constructor(
    @InjectModel(DailyUserStat.name)
    private readonly statModel: Model<DailyUserStatDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
  ) {}

  /**
   * Thống kê theo (ngày, user_id) từ toàn bộ orders rồi upsert vào
   * daily_user_stats. Idempotent — chạy lại bao nhiêu lần cũng ra cùng kết quả,
   * nên scheduler 5 phút chỉ việc recompute (refund đơn cũ cũng tự cập nhật).
   * Trả về số dòng đã upsert.
   */
  async recompute(): Promise<number> {
    // Dòng được upsert trong lần chạy này có updatedAt >= runStart;
    // sau khi upsert xong, mọi dòng cũ hơn = không còn dữ liệu nguồn (vd đơn
    // đã bị xóa) → xóa đi để bảng luôn khớp với orders.
    const runStart = new Date();

    const rows: {
      _id: { day: string; user_id: Types.ObjectId };
      orders_count: number;
      revenue: number;
      cost: number;
      refunded: number;
    }[] = await this.orderModel.aggregate([
      { $match: { user_id: { $ne: null } } },
      {
        $group: {
          _id: {
            day: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt',
                timezone: '+07:00',
              },
            },
            user_id: '$user_id',
          },
          orders_count: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                IS_VALID_PAID,
                {
                  $subtract: [
                    '$total_price',
                    { $ifNull: ['$refunded_amount', 0] },
                  ],
                },
                0,
              ],
            },
          },
          cost: {
            $sum: {
              $cond: [IS_VALID_PAID, { $ifNull: ['$total_cost', 0] }, 0],
            },
          },
          refunded: { $sum: { $ifNull: ['$refunded_amount', 0] } },
        },
      },
    ]);

    const ops = rows.map((r) => ({
      updateOne: {
        filter: {
          stat_date: dayKeyToTimestamp(r._id.day),
          user_id: r._id.user_id,
        },
        update: {
          $set: {
            orders_count: r.orders_count,
            revenue: r.revenue,
            cost: r.cost,
            profit: r.revenue - r.cost,
            refunded: r.refunded,
          },
        },
        upsert: true,
      },
    }));

    let upserted = 0;
    for (let i = 0; i < ops.length; i += BULK_CHUNK) {
      const res = await this.statModel
        .bulkWrite(ops.slice(i, i + BULK_CHUNK), { ordered: false });
      upserted +=
        res.upsertedCount + res.modifiedCount;
    }

    // Prune dòng stale (không được chạm trong lần chạy này)
    const pruned = await this.statModel.deleteMany({
      updatedAt: { $lt: runStart },
    });

    this.logger.log(
      `Recomputed daily_user_stats: ${rows.length} day×user rows (${upserted} changed, ${pruned.deletedCount} pruned)`,
    );
    return rows.length;
  }

  /** Danh sách thống kê cho admin (phân trang + filter khoảng ngày / user) */
  async getDaily(params: {
    page?: string;
    limit?: string;
    from_date?: string;
    to_date?: string;
    user_id?: string;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));

    const filter: Record<string, unknown> = {};
    if (params.from_date || params.to_date) {
      const range: Record<string, Date> = {};
      if (params.from_date) range.$gte = dayKeyToTimestamp(params.from_date);
      if (params.to_date) {
        // Hết ngày to_date (00:00 ngày kế tiếp, UTC+7)
        range.$lt = new Date(
          dayKeyToTimestamp(params.to_date).getTime() + 86400000,
        );
      }
      filter.stat_date = range;
    }
    if (params.user_id) {
      if (!Types.ObjectId.isValid(params.user_id)) {
        throw new BadRequestException('user_id không hợp lệ');
      }
      filter.user_id = new Types.ObjectId(params.user_id);
    }

    const [total, data] = await Promise.all([
      this.statModel.countDocuments(filter),
      this.statModel
        .find(filter)
        .populate('user_id', 'email name')
        .sort({ stat_date: -1, revenue: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
