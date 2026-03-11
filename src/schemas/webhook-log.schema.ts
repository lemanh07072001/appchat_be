import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WebhookLogDocument = WebhookLog & Document & {
  createdAt: Date;
  updatedAt: Date;
};

export enum WebhookStepStatus {
  OK    = 'ok',
  WARN  = 'warn',
  ERROR = 'error',
}

export interface WebhookStep {
  step:   number;
  title:  string;
  detail: string;
  status: WebhookStepStatus;
  data?:  Record<string, any>;
}

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

  /** Các bước xử lý từng transaction — hiển thị "Điều tra nạp tiền" */
  @Prop({ type: [Object], default: [] })
  steps: WebhookStep[];

  @Prop({ default: 200 })
  status_code: number;

  @Prop({ default: '' })
  ip: string;
}

export const WebhookLogSchema = SchemaFactory.createForClass(WebhookLog);

WebhookLogSchema.index({ createdAt: -1 });
WebhookLogSchema.index({ source: 1 });
