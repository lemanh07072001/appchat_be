import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

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

  @Prop({ default: '' })
  partner: string;

  @Prop({ default: '' })
  country: string;

  @Prop({ default: '' })
  body_api: string;

  @Prop({ default: '' })
  protocol: string;

  @Prop({ default: '' })
  note: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  pricing: Record<string, any>;
}

export const ServiceSchema = SchemaFactory.createForClass(Service);
