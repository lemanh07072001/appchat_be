import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

export interface PromotionQuote {
  promotionId: string | null;
  promotionName: string | null;
  rate: number;
  bonusAmount: number;
  totalAmount: number;
  amount: number;
}

// One catalog document gives program edits a standalone-Mongo atomic CAS boundary.
@Schema({ timestamps: true })
export class DepositPromotionCatalog {
  @Prop({ type: String }) _id: string;
  @Prop({ default: 0 }) revision: number;
  @Prop({ type: [Object], default: [] }) programs: any[];
}
export const DepositPromotionCatalogSchema = SchemaFactory.createForClass(DepositPromotionCatalog);

@Schema({ timestamps: true })
export class DepositIntent {
  @Prop({ required: true, unique: true }) code: string;
  @Prop({ type: Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: Object, required: true }) quote: PromotionQuote;
  @Prop({ type: Object, default: null }) terms: any;
  @Prop({ required: true }) issuedAt: Date;
  @Prop({ required: true }) expiresAt: Date;
  @Prop({ type: String, default: null }) consumedBy: string | null;
}
export const DepositIntentSchema = SchemaFactory.createForClass(DepositIntent);
