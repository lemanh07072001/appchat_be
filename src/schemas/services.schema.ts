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

  @Prop({ type: [String], default: [] })
  isp: string[];

  @Prop({ default: true })
  is_show: boolean;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  pricing: Record<string, any>;
}

export const ServiceSchema = SchemaFactory.createForClass(Service);
