import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type IpDocument = Ip & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class Ip {
  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  code: string;

  @Prop({ default: '' })
  note: string;

  @Prop({ default: true })
  status: boolean;

  @Prop({ default: 0 })
  order: number;
}

export const IpSchema = SchemaFactory.createForClass(Ip);
