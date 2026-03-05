import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AffiliateCommissionDocument = AffiliateCommission & Document & {
  createdAt: Date;
  updatedAt: Date;
};

export enum AffiliateCommissionStatus {
  CONFIRMED  = 'confirmed',  // Đơn hàng COMPLETED → hoa hồng được xác nhận
  PAID       = 'paid',       // Đã cộng vào affiliate_balance
  CANCELLED  = 'cancelled',  // Đơn bị huỷ sau khi đã confirm
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
    default: AffiliateCommissionStatus.CONFIRMED,
  })
  status: AffiliateCommissionStatus;

  @Prop({ type: Date, default: Date.now })
  confirmed_at: Date;

  @Prop({ type: Date, default: null })
  paid_at: Date;
}

export const AffiliateCommissionSchema = SchemaFactory.createForClass(AffiliateCommission);

AffiliateCommissionSchema.index({ referrer_id: 1, status: 1 });
AffiliateCommissionSchema.index({ referred_user_id: 1 });
