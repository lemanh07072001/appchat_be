import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ServiceDocument = Service & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class Service {
  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  type: string;

  @Prop({ default: true })
  status: boolean;

  @Prop({ default: '' })
  proxy_type: string;

  @Prop({ default: '' })
  ip_version: string;

  @Prop({ type: Types.ObjectId, ref: 'Partner', default: null })
  partner: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Country', default: null })
  country: Types.ObjectId;

  @Prop({ default: '' })
  body_api: string;

  @Prop({ default: '' })
  id_service: string;

  @Prop({ type: [String], default: [] })
  protocol: string[];

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  note: Record<string, string>;

  @Prop({ type: [{ name: String, code: String }], default: [] })
  isp: { name: string; code: string }[];

  @Prop({ default: 'private' })
  usage_type: string;

  @Prop({ default: true })
  is_show: boolean;

  @Prop({ default: false })
  api_enabled: boolean;

  @Prop({ default: true })
  show_user_pass: boolean;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  pricing: Record<string, any>;

  @Prop({ default: '' })
  badge: string;

  // Map số ngày → product ID của provider (HomeProxy có ID khác nhau theo thời hạn)
  // VD: { "1": "uuid-1day", "7": "uuid-7day", "30": "uuid-30day" }
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  duration_ids: Record<string, string>;

  @Prop({ default: 0 })
  order: number;
}

export const ServiceSchema = SchemaFactory.createForClass(Service);
