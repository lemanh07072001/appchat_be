import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'provider_connector_accounts' })
export class ConnectorAccount {
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) connectorCode: string;
  @Prop({ required: true }) connectorVersion: number;
  @Prop({ required: true, select: false }) credential: string;
  @Prop({ default: true }) enabled: boolean;
  @Prop({ default: 0 }) revision: number;
  @Prop({ type: Types.ObjectId }) legacyPartnerId?: Types.ObjectId;
  /** Source identity inherited by successors; separate from the unique migration receipt. */
  @Prop({ type: Types.ObjectId }) sourcePartnerId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId }) predecessorAccountId?: Types.ObjectId;
}
export const ConnectorAccountSchema = SchemaFactory.createForClass(ConnectorAccount);
ConnectorAccountSchema.index({ legacyPartnerId: 1 }, { unique: true,
  partialFilterExpression: { legacyPartnerId: { $type: 'objectId' } } });
ConnectorAccountSchema.index({ predecessorAccountId: 1, connectorVersion: 1 }, { unique: true,
  partialFilterExpression: { predecessorAccountId: { $type: 'objectId' } } });
