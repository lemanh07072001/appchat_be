import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
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
}

export const UserSchema = SchemaFactory.createForClass(User);
