import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PartnerDocument = Partner & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class Partner {
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
