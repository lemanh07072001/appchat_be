import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { HealthStatusEnum, ProxyProtocolEnum } from '../enum/proxy.enum';

export type ProxyDocument = Proxy & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class Proxy {
  @Prop({ type: Types.ObjectId, ref: 'Order', default: null })
  order_id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Service', default: null })
  proxy_type_id: Types.ObjectId;

  @Prop({ required: true })
  ip_address: string;

  @Prop({ required: true })
  port: number;

  @Prop({ type: String, enum: ProxyProtocolEnum, required: true })
  protocol: ProxyProtocolEnum;

  @Prop({ required: true })
  auth_username: string;

  @Prop({ required: true })
  auth_password: string;

  @Prop({ required: true, maxlength: 5 })
  country_code: string;

  @Prop({ default: '' })
  region: string;

  @Prop({ default: '' })
  city: string;

  @Prop({ type: String })
  provider_proxy_id: string;

  // Key xoay CDK — chỉ có với proxy isCdk:true (HomeProxy). Không set default để sparse index hoạt động đúng
  @Prop({ type: String })
  cdk_key?: string;

  @Prop({ default: '' })
  domain: string;

  @Prop({ default: '' })
  prev_ip: string;

  @Prop({ default: '' })
  location: string;

  @Prop({ default: '' })
  isp: string;

  @Prop({ default: '' })
  datacenter: string;

  @Prop({ default: '' })
  provider: string;

  @Prop({ default: true })
  is_active: boolean;

  @Prop({ default: true })
  is_available: boolean;

  @Prop({ type: String, enum: HealthStatusEnum, default: HealthStatusEnum.HEALTHY })
  health_status: HealthStatusEnum;

  @Prop({ type: Date, default: null })
  last_checked_at: Date;
}

export const ProxySchema = SchemaFactory.createForClass(Proxy);

ProxySchema.index({ order_id: 1 });
ProxySchema.index({ provider_proxy_id: 1 }, { sparse: true });
ProxySchema.index({ cdk_key: 1 }, { unique: true, sparse: true });
ProxySchema.index({ is_active: 1, is_available: 1 });
