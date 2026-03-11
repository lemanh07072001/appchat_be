import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WebhookLogDocument = WebhookLog & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class WebhookLog {
  @Prop({ required: true })
  source: string;             // 'pays2'

  @Prop({ type: Object, default: null })
  headers: Record<string, any> | null;

  @Prop({ type: Object, default: null })
  payload: Record<string, any> | null;

  @Prop({ type: Object, default: null })
  response: Record<string, any> | null;

  @Prop({ default: 200 })
  status_code: number;

  @Prop({ default: '' })
  ip: string;
}

export const WebhookLogSchema = SchemaFactory.createForClass(WebhookLog);

WebhookLogSchema.index({ createdAt: -1 });
WebhookLogSchema.index({ source: 1 });
