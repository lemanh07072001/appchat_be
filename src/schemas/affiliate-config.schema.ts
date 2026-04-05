import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AffiliateConfigDocument = AffiliateConfig & Document;

@Schema()
export class AffiliateConfig {
  @Prop({ type: Number, default: 10 })
  commission_rate: number;   // % hoa hồng trên total_price

  @Prop({ type: Boolean, default: true })
  is_active: boolean;        // Bật/tắt toàn bộ hệ thống affiliate
}

export const AffiliateConfigSchema = SchemaFactory.createForClass(AffiliateConfig);
