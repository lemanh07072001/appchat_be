import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type OrderLogDocument = OrderLog & Document;

export enum OrderLogLevel {
  INFO  = 'info',
  WARN  = 'warn',
  ERROR = 'error',
  DEBUG = 'debug',
}

export enum OrderLogStep {
  // ─── Buy flow (OrdersService.buy) ───────────────────────────────────
  BUY_INITIATED          = 'buy.initiated',
  BUY_SERVICE_VALIDATED  = 'buy.service_validated',
  BUY_PRICING_RESOLVED   = 'buy.pricing_resolved',
  BUY_COUNTRY_RESOLVED   = 'buy.country_resolved',
  BUY_BALANCE_DEDUCTED   = 'buy.balance_deducted',
  BUY_ORDER_CREATED      = 'buy.order_created',
  BUY_QUEUED             = 'buy.queued',
  BUY_FAILED             = 'buy.failed',

  // ─── Worker flow (OrdersWorkerService) ──────────────────────────────
  WORKER_RECEIVED        = 'worker.received',
  WORKER_LOCK_ACQUIRED   = 'worker.lock_acquired',
  WORKER_LOCK_SKIPPED    = 'worker.lock_skipped',
  WORKER_ORDER_VERIFIED  = 'worker.order_verified',
  WORKER_PROVIDER_CALL   = 'worker.provider_call',
  WORKER_PROVIDER_RETRY  = 'worker.provider_retry',
  WORKER_PROVIDER_OK     = 'worker.provider_ok',
  WORKER_PROVIDER_FAIL   = 'worker.provider_fail',
  WORKER_PROXIES_INSERTED= 'worker.proxies_inserted',
  WORKER_STATUS_ACTIVE   = 'worker.status_active',
  WORKER_STATUS_PARTIAL  = 'worker.status_partial',
  WORKER_STATUS_PROCESSING = 'worker.status_processing',
  WORKER_STATUS_PENDING_REFUND = 'worker.status_pending_refund',
  WORKER_PARTNER_FAIL_COUNT = 'worker.partner_fail_count',
  WORKER_PARTNER_DISABLED= 'worker.partner_disabled',

  // ─── Polling scheduler (OrdersProcessingScheduler) ──────────────────
  POLLING_STARTED        = 'polling.started',
  POLLING_FETCHED        = 'polling.fetched',
  POLLING_PROXIES_OK     = 'polling.proxies_ok',
  POLLING_NO_PROXIES     = 'polling.no_proxies',
  POLLING_FAILED         = 'polling.failed',

  // ─── Expiration scheduler ────────────────────────────────────────────
  EXPIRED                = 'expired',

  // ─── Admin actions ───────────────────────────────────────────────────
  ADMIN_STATUS_UPDATED   = 'admin.status_updated',
  ADMIN_PAYMENT_UPDATED  = 'admin.payment_updated',
  ADMIN_REFUND_APPROVED  = 'admin.refund_approved',
  ADMIN_ORDER_CREATED    = 'admin.order_created',
  ADMIN_ORDER_DELETED    = 'admin.order_deleted',
  ADMIN_ORDER_RENEWED    = 'admin.order_renewed',
  USER_ORDER_RENEWED     = 'user.order_renewed',
  ADMIN_ORDER_RETRY      = 'admin.order_retry',
  ADMIN_PROXY_IMPORTED   = 'admin.proxy_imported',
}

@Schema({ collection: 'order_logs', timestamps: true })
export class OrderLog {
  @Prop({ type: Types.ObjectId, ref: 'Order', required: true, index: true })
  order_id: Types.ObjectId;

  @Prop({ type: String, enum: OrderLogStep, required: true })
  step: OrderLogStep;

  @Prop({ type: String, enum: OrderLogLevel, default: OrderLogLevel.INFO })
  level: OrderLogLevel;

  @Prop({ type: String, default: '' })
  message: string;

  /** Dữ liệu tùy bước: request params, response, error stack, v.v. */
  @Prop({ type: Object, default: {} })
  data: Record<string, any>;

  /** Thời gian thực hiện bước này (ms) — tùy chọn */
  @Prop({ type: Number, default: null })
  duration_ms: number | null;

  /** Ai trigger (userId nếu user, 'system' nếu worker/scheduler) */
  @Prop({ type: String, default: 'system' })
  actor: string;
}

export const OrderLogSchema = SchemaFactory.createForClass(OrderLog);

// Index để query nhanh theo order + thời gian
OrderLogSchema.index({ order_id: 1, createdAt: 1 });
