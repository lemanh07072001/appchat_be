import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AffiliateCommissionDocument = AffiliateCommission & Document & {
  createdAt: Date;
  updatedAt: Date;
};

export enum AffiliateCommissionStatus {
  PENDING    = 'pending',    // Order đang ACTIVE — chưa đủ điều kiện rút
  CONFIRMED  = 'confirmed',  // Order đã EXPIRED — Đủ điều kiện, chờ admin duyệt
  CREDITED   = 'credited',   // Admin đã duyệt, đã cộng vào affiliate_balance
  REQUESTED  = 'requested',  // User yêu cầu rút về ngân hàng — chờ admin chuyển khoản
  PAID       = 'paid',       // Admin đã chuyển khoản, user đã nhận tiền
  CANCELLED  = 'cancelled',  // Đơn bị huỷ
}

@Schema({ timestamps: true })
export class AffiliateCommission {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  referrer_id: Types.ObjectId;       // Người nhận hoa hồng

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  referred_user_id: Types.ObjectId;  // Người mua hàng

  @Prop({ type: Types.ObjectId, ref: 'Order', required: true, unique: true })
  order_id: Types.ObjectId;          // Mỗi đơn chỉ tạo 1 commission

  @Prop({ type: Number, required: true })
  order_total: number;               // total_price của đơn

  @Prop({ type: Number, required: true })
  commission_rate: number;           // % tại thời điểm tạo

  @Prop({ type: Number, required: true })
  commission_amount: number;         // order_total * commission_rate / 100

  @Prop({
    type: String,
    enum: AffiliateCommissionStatus,
    default: AffiliateCommissionStatus.PENDING,
  })
  status: AffiliateCommissionStatus;

  @Prop({ type: Date, default: null })
  confirmed_at: Date;

  @Prop({ type: Date, default: null })
  credited_at: Date;         // Khi admin cộng vào affiliate_balance

  @Prop({ type: Date, default: null })
  requested_at: Date;

  @Prop({ type: Date, default: null })
  paid_at: Date;

  // ─── Snapshot thông tin ngân hàng tại thời điểm yêu cầu rút ─────────────
  @Prop({ default: '' })
  bank_name: string;

  @Prop({ default: '' })
  bank_account: string;

  @Prop({ default: '' })
  bank_owner: string;
}

export const AffiliateCommissionSchema = SchemaFactory.createForClass(AffiliateCommission);

AffiliateCommissionSchema.index({ referrer_id: 1, status: 1 });
AffiliateCommissionSchema.index({ referred_user_id: 1 });
