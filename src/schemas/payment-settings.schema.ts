import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PaymentSettingsDocument = PaymentSettings & Document;

@Schema()
export class PaymentSettings {
  @Prop({ type: Boolean, default: true })
  bank_enabled: boolean;        // Bật/tắt nạp qua chuyển khoản ngân hàng

  @Prop({ type: Boolean, default: true })
  binance_pay_enabled: boolean; // Bật/tắt nạp qua Binance Pay
}

export const PaymentSettingsSchema = SchemaFactory.createForClass(PaymentSettings);
