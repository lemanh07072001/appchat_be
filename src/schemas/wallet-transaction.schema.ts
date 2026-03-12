import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WalletTransactionDocument = WalletTransaction & Document & {
  createdAt: Date;
  updatedAt: Date;
};

export enum WalletTxType {
  DEPOSIT   = 'deposit',   // Nạp tiền (bank / admin thủ công)
  PURCHASE  = 'purchase',  // Mua proxy
  REFUND    = 'refund',    // Hoàn tiền
  DEDUCTION = 'deduction', // Admin trừ thủ công
}

@Schema({ timestamps: true })
export class WalletTransaction {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user_id: Types.ObjectId;

  @Prop({ required: true, enum: WalletTxType })
  type: WalletTxType;

  /** Luôn dương — chiều tăng/giảm xác định bởi direction */
  @Prop({ required: true, type: Number })
  amount: number;

  /** 'in' = cộng tiền, 'out' = trừ tiền */
  @Prop({ required: true, enum: ['in', 'out'] })
  direction: 'in' | 'out';

  @Prop({ type: Number, default: 0 })
  balance_before: number;

  @Prop({ type: Number, default: 0 })
  balance_after: number;

  @Prop({ default: '' })
  description: string;

  /** ID đơn hàng / mã giao dịch ngân hàng / ... */
  @Prop({ default: null })
  ref_id: string | null;

  /** 'order' | 'bank_transaction' | ... */
  @Prop({ default: null })
  ref_type: string | null;

  /** 'system' | 'webhook' | 'admin' */
  @Prop({ default: 'system' })
  created_by: string;
}

export const WalletTransactionSchema = SchemaFactory.createForClass(WalletTransaction);

WalletTransactionSchema.index({ user_id: 1, createdAt: -1 });
WalletTransactionSchema.index({ type: 1 });
WalletTransactionSchema.index({ ref_id: 1 });
