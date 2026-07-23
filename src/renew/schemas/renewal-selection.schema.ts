import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type RenewalSelectionDocument = RenewalSelection & Document;

/**
 * Bộ proxy user lưu lại để gia hạn nhanh lần sau.
 * - name = null → bản "lần gia hạn gần nhất" (tự upsert sau mỗi lần gia hạn thành công)
 * - name != null → bộ do user tự đặt tên
 */
@Schema({ timestamps: true, collection: 'renewal_selections' })
export class RenewalSelection {
  @Prop({ required: true, index: true, ref: 'User' })
  user_id: Types.ObjectId;

  /** null = bộ tự động "lần trước"; string = bộ đặt tên */
  @Prop({ type: String, default: null })
  name: string | null;

  @Prop({ type: [Types.ObjectId], default: [], ref: 'Proxy' })
  proxy_ids: Types.ObjectId[];

  /** Thời hạn dùng lần gần nhất — khôi phục cùng lựa chọn, cũng là thời hạn tự gia hạn */
  @Prop({ default: 30 })
  duration_days: number;

  // ─── Đặt lịch tự gia hạn (chỉ bộ đặt tên mới bật được) ──────────────────

  @Prop({ default: false, index: true })
  auto_renew_enabled: boolean;

  /** Tự gia hạn khi đơn chứa proxy còn <= N ngày */
  @Prop({ default: 3, min: 1, max: 30 })
  threshold_days: number;

  @Prop({ type: Date, default: null })
  last_run_at: Date | null;

  /** success | partial | failed | disabled (tự tắt do thiếu tiền) */
  @Prop({ type: String, default: null })
  last_run_status: string | null;

  /** Mô tả kết quả lần chạy cuối — hiện nguyên văn cho user trên trang /renew */
  @Prop({ default: '' })
  last_run_message: string;

  @Prop({ type: String, default: null })
  last_run_bulk_ref: string | null;
}

export const RenewalSelectionSchema =
  SchemaFactory.createForClass(RenewalSelection);

// Mỗi user chỉ có 1 bộ cho mỗi tên (và 1 bản "lần trước" với name = null)
RenewalSelectionSchema.index({ user_id: 1, name: 1 }, { unique: true });
