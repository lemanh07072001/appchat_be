import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { ConnectorDefinition } from './connector-definition';

@Schema({ timestamps: true, collection: 'provider_connector_versions' })
export class ConnectorVersion {
  @Prop({ required: true }) code: string;
  @Prop({ required: true }) name: string;
  @Prop({ required: true, min: 1 }) version: number;
  @Prop({ required: true, enum: ['draft', 'published'], default: 'draft' }) status: string;
  @Prop({ type: Object, required: true }) definition: ConnectorDefinition;
  @Prop({ required: true, default: 0 }) revision: number;
}
export const ConnectorVersionSchema = SchemaFactory.createForClass(ConnectorVersion);
ConnectorVersionSchema.index({ code: 1, version: 1 }, { unique: true });
