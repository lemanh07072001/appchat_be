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

  /** Thời hạn dùng lần gần nhất — khôi phục cùng lựa chọn */
  @Prop({ default: 30 })
  duration_days: number;
}

export const RenewalSelectionSchema =
  SchemaFactory.createForClass(RenewalSelection);

// Mỗi user chỉ có 1 bộ cho mỗi tên (và 1 bản "lần trước" với name = null)
RenewalSelectionSchema.index({ user_id: 1, name: 1 }, { unique: true });
