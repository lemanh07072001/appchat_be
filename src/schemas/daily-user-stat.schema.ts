import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DailyUserStatDocument = DailyUserStat & Document;

/**
 * Bảng thống kê riêng theo (ngày, user_id) — nạp bởi StatsScheduler mỗi 5 phút
 * (recompute toàn bộ từ orders, upsert idempotent).
 */
@Schema({ timestamps: true })
export class DailyUserStat {
  /** Ngày thống kê — timestamp 00:00 (UTC+7) của ngày đó */
  @Prop({ required: true, index: true })
  stat_date: Date;

  @Prop({ required: true, index: true, ref: 'User' })
  user_id: Types.ObjectId;

  /** Số đơn hàng tạo trong ngày */
  @Prop({ default: 0 })
  orders_count: number;

  /** Doanh thu thuần = Σ(total_price − refunded_amount) đơn đã trả & hợp lệ */
  @Prop({ default: 0 })
  revenue: number;

  /** Giá vốn = Σ total_cost ($ifNull 0) đơn đã trả & hợp lệ */
  @Prop({ default: 0 })
  cost: number;

  /** Lợi nhuận = revenue − cost */
  @Prop({ default: 0 })
  profit: number;

  /** Tiền hoàn trên các đơn tạo trong ngày — KHÔNG tính vào revenue */
  @Prop({ default: 0 })
  refunded: number;
}

export const DailyUserStatSchema =
  SchemaFactory.createForClass(DailyUserStat);

// Một dòng duy nhất cho mỗi (ngày, user)
DailyUserStatSchema.index({ stat_date: 1, user_id: 1 }, { unique: true });
