import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { UserRoleEnum, UserStatusEnum } from '../enum/user.enum';

export type UserDocument = User & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ required: true })
  password: string;

  @Prop({ default: '' })
  avatar: string;

  @Prop({ type: Number, default: UserRoleEnum.USER })
  role: UserRoleEnum;

  @Prop({ type: Number, default: UserStatusEnum.ACTIVE })
  status: UserStatusEnum;

  @Prop({ type: Date, default: Date.now })
  email_verified_at: Date;

  @Prop({ type: Date, default: Date.now })
  last_login_at: Date;

  @Prop({ type: Number, default: 0 })
  money: number;

  @Prop({ default: '' })
  country: string;

  // ─── Mã nạp tiền ──────────────────────────────────────────
  @Prop({ default: '', unique: true, sparse: true })
  topup_code: string;           // Mã định danh khi chuyển khoản, VD: NAP123456

  // ─── Affiliate ────────────────────────────────────────────
  @Prop({ default: '', unique: true, sparse: true })
  referral_code: string;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  referred_by: Types.ObjectId;

  @Prop({ type: Number, default: 0 })
  affiliate_balance: number;

  // ─── Thông tin ngân hàng (để rút hoa hồng) ───────────────
  @Prop({ default: '' })
  bank_name: string;

  @Prop({ default: '' })
  bank_account: string;

  @Prop({ default: '' })
  bank_owner: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
