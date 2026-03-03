import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProxyTypeDocument = ProxyType & Document;

@Schema({ timestamps: true })
export class ProxyType {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ default: '' })
  name: string;
}

export const ProxyTypeSchema = SchemaFactory.createForClass(ProxyType);
