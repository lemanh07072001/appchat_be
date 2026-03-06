import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum WithdrawalStatus {
  REQUESTED = 'requested',
  PAID      = 'paid',
  REJECTED  = 'rejected',
}

export type WithdrawalDocument = Withdrawal & Document;

@Schema({ timestamps: true })
export class Withdrawal {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user_id: Types.ObjectId;

  @Prop({ required: true })
  total_amount: number;

  @Prop({ default: '' })
  bank_name: string;

  @Prop({ required: true })
  bank_account: string;

  @Prop({ default: '' })
  bank_owner: string;

  @Prop({ type: String, enum: WithdrawalStatus, default: WithdrawalStatus.REQUESTED, index: true })
  status: WithdrawalStatus;

  // Danh sách commission IDs được gộp vào lần rút này
  @Prop({ type: [Types.ObjectId], ref: 'AffiliateCommission', default: [] })
  commission_ids: Types.ObjectId[];

  @Prop({ type: Date, default: () => new Date() })
  requested_at: Date;

  @Prop({ type: Date, default: null })
  paid_at: Date;

  @Prop({ type: Date, default: null })
  rejected_at: Date;
}

export const WithdrawalSchema = SchemaFactory.createForClass(Withdrawal);
