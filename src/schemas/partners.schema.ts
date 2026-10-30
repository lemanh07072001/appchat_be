import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PartnerDocument = Partner & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class Partner {
  @Prop({ type: String, enum: ['manual', 'api', 'none'] })
  country_source?: string;

  @Prop({ type: [{ _id: false, code: String, name: String, provider_value: String }], default: undefined })
  country_options?: { code: string; name?: string; provider_value?: string }[];

  @Prop({ required: true })
  name: string;

  @Prop({ default: true })
  status: boolean;

  @Prop({ default: '' })
  token_api: string;

  @Prop({ default: '' })
  code: string;

  @Prop({ default: 0 })
  order: number;
}

export const PartnerSchema = SchemaFactory.createForClass(Partner);
