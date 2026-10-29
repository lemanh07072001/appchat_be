import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** Permanent dispatch fence. Never TTL/delete this record while its order exists. */
@Schema({ timestamps: true, collection: 'provider_dispatches' })
export class ConnectorDispatch {
  @Prop({ required: true }) reference: string;
  @Prop({ required: true }) orderId: string;
  @Prop({ required: true }) accountId: string;
  @Prop({ required: true }) connectorCode: string;
  @Prop({ required: true }) connectorVersion: number;
  @Prop({ required: true }) action: string;
  @Prop({ required: true }) inputHash: string;
  @Prop({ required: true }) owner: string;
  @Prop({ required: true, enum: ['claimed', 'submitted', 'completed', 'unknown'] }) status: string;
  @Prop() submittedAt?: Date;
  @Prop() completedAt?: Date;
  // Normalized proxy credentials may be present: never store plaintext or select by default.
  @Prop({ select: false }) encryptedResult?: string;
  @Prop() resultSavedAt?: Date;
}
export const ConnectorDispatchSchema = SchemaFactory.createForClass(ConnectorDispatch);
// Global reference, not per account: changing an account must not purchase again.
ConnectorDispatchSchema.index({ reference: 1 }, { unique: true });
ConnectorDispatchSchema.index({ orderId: 1, createdAt: -1 });
