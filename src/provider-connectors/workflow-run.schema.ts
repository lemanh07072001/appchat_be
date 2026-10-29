import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true, collection: 'provider_workflow_runs' })
export class PersistedWorkflowRun {
  @Prop({ required: true }) connectorCode: string;
  @Prop({ required: true }) definitionVersion: number;
  @Prop({ required: true }) workflow: string;
  @Prop({ required: true }) requestReference: string;
  @Prop({ required: true }) accountId: string;
  @Prop({ required: true }) step: string;
  @Prop({ required: true, enum: ['ready', 'running', 'waiting', 'completed', 'rejected', 'unknown'] }) status: string;
  @Prop({ type: Object, default: {} }) variables: Record<string, unknown>;
  @Prop({ type: Object }) output?: Record<string, unknown>;
  @Prop() nextCheckAt?: number;
  @Prop() leaseOwner?: string;
  @Prop() leaseUntil?: number;
  @Prop({ default: 0 }) attempts: number;
  @Prop({ required: true }) deadlineAt: number;
  @Prop({ type: [Object], default: [] }) history: { step: string; status: string; at: number }[];
}
export const PersistedWorkflowRunSchema = SchemaFactory.createForClass(PersistedWorkflowRun);
PersistedWorkflowRunSchema.index({ accountId: 1, requestReference: 1 }, { unique: true });
PersistedWorkflowRunSchema.index({ status: 1, nextCheckAt: 1 });
PersistedWorkflowRunSchema.index({ status: 1, leaseUntil: 1 });
