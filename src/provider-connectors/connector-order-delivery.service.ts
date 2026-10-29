import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Order } from '../schemas/orders.schema';
import { Proxy } from '../schemas/proxies.schema';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';
import { ProxyProtocolEnum } from '../enum/proxy.enum';
import { ConnectorRuntime } from './connector-runtime.service';
import { validateConnectorResult } from './connector-contract';

/** Read-only upstream polling; local fulfillment is atomic and repeatable after crashes. */
@Injectable()
export class ConnectorOrderDelivery {
  constructor(@InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Proxy.name) private readonly proxies: Model<Proxy>, private readonly runtime: ConnectorRuntime) {}

  async poll(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) throw new BadRequestException('Invalid order ID');
    const order = await this.orders.findById(orderId).lean().exec();
    const binding = order?.connector_purchase;
    if (!order || !binding || order.status !== OrderStatusEnum.PROCESSING ||
        order.payment_status !== PaymentStatusEnum.PAID || order.connector_purchase_state !== 'awaiting_delivery' ||
        !order.provider_order_id || order.voucher_snapshot) return { delivered: false };
    // Caller cannot override the upstream order ID or use a newer template version.
    const output = validateConnectorResult('fetch', await this.runtime.read(binding.accountId, 'fetch',
      { ...binding.input, orderId: order.provider_order_id }, binding));
    const items = output.items!;
    if (items.length === 0) return { delivered: false };
    if (!Number.isSafeInteger(order.quantity) || order.quantity < 1 || items.length > order.quantity ||
        !Number.isSafeInteger(order.duration_days) || order.duration_days < 1 || order.duration_days > 3650) {
      throw new BadGatewayException('Provider delivery quantity/duration requires reconciliation');
    }
    const keys = new Set<string>();
    const now = new Date();
    const requestedProtocol = binding.input.protocol;
    const selection = binding.protocolSelection;
    const dual = selection?.mode === 'dual';
    if (selection && (!['fixed', 'select', 'dual'].includes(selection.mode) ||
        !Array.isArray(selection.protocols) || (dual
          ? selection.protocols.length !== 2 || !selection.protocols.includes('http') ||
            !selection.protocols.includes('socks5') || requestedProtocol !== undefined
          : selection.protocols.length !== 1 || selection.protocols[0] !== requestedProtocol))) {
      throw new BadGatewayException('Pinned delivery protocol requires reconciliation');
    }
    if (requestedProtocol !== undefined && !Object.values(ProxyProtocolEnum).includes(requestedProtocol as ProxyProtocolEnum)) {
      throw new BadGatewayException('Pinned delivery protocol requires reconciliation');
    }
    const start = order.start_date ?? now;
    if (!(start instanceof Date) || !Number.isFinite(start.getTime())) {
      throw new BadGatewayException('Local delivery lifetime requires reconciliation');
    }
    const requestedEnd = order.end_date ?? new Date(start.getTime() + order.duration_days * 86400_000);
    if (!(requestedEnd instanceof Date) || !Number.isFinite(requestedEnd.getTime()) ||
        requestedEnd.getTime() <= Math.max(start.getTime(), now.getTime())) {
      throw new BadGatewayException('Local delivery lifetime requires reconciliation');
    }
    const upstreamExpirations: number[] = [];
    const documents = items.map(item => {
      const dualOutput = item.httpPort !== undefined || item.socks5Port !== undefined;
      if (dual !== dualOutput) throw new BadGatewayException('Proxy delivery protocol mode requires reconciliation');
      // HTTP is the compatibility primary endpoint only; both endpoints belong to this one proxy.
      const protocol = dual ? 'http' : item.protocol;
      const port = dual ? item.httpPort : item.port;
      if (item.orderId !== undefined && item.orderId !== order.provider_order_id) {
        throw new BadGatewayException('Provider delivery belongs to a different order');
      }
      if (item.expiresAt !== undefined) {
        if (typeof item.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(item.expiresAt) ||
            !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= now.getTime()) {
          throw new BadGatewayException('Provider delivery expiration requires reconciliation');
        }
        upstreamExpirations.push(Date.parse(item.expiresAt));
      }
      // Do not silently transform unsupported protocols or invent authentication credentials.
      if (!Object.values(ProxyProtocolEnum).includes(protocol as ProxyProtocolEnum) ||
          requestedProtocol !== undefined && protocol !== requestedProtocol ||
          typeof item.username !== 'string' || !item.username.trim() || typeof item.password !== 'string' || !item.password.trim() ||
          /[\x00-\x1f\x7f]/.test(item.username) || /[\x00-\x1f\x7f]/.test(item.password)) {
        throw new BadGatewayException('Proxy delivery is incompatible with local storage');
      }
      const key = createHash('sha256').update(JSON.stringify([String(order._id), item.host, port, protocol, item.username])).digest('hex');
      if (keys.has(key)) throw new BadGatewayException('Provider delivery contains duplicate proxies');
      keys.add(key);
      return { connector_delivery_key: key, order_id: order._id, proxy_type_id: order.service_id,
        ip_address: item.host, port, protocol,
        ...(dual ? { access_endpoints: [{ protocol: 'http', port: item.httpPort },
          { protocol: 'socks5', port: item.socks5Port }] } : {}),
        auth_username: item.username, auth_password: item.password, country_code: 'ZZ',
        provider: binding.connectorCode, is_active: true, is_available: false,
        ...(typeof item.id === 'string' ? { provider_proxy_id: item.id } : {}) };
    });
    // Validate the complete lease before opening a transaction. An upstream expiry
    // may be future relative to now but still precede an existing pinned start.
    const end = new Date(Math.min(requestedEnd.getTime(), ...upstreamExpirations));
    if (end.getTime() <= Math.max(start.getTime(), now.getTime())) {
      throw new BadGatewayException('Provider delivery lifetime requires reconciliation');
    }
    const session = await this.orders.db.startSession();
    let delivered = false;
    try {
      await session.withTransaction(async () => {
        delivered = false;
        // Never advertise a local lifetime longer than an explicitly mapped upstream lease.
        const changed = await this.orders.updateOne({ _id: order._id, status: OrderStatusEnum.PROCESSING,
          payment_status: PaymentStatusEnum.PAID, connector_purchase_state: 'awaiting_delivery',
          connector_purchase: binding, provider_order_id: order.provider_order_id,
          quantity: order.quantity, duration_days: order.duration_days,
          start_date: order.start_date ?? null, end_date: order.end_date ?? null }, { $set: {
          status: documents.length === order.quantity ? OrderStatusEnum.ACTIVE : OrderStatusEnum.PARTIAL,
          actual_quantity: documents.length, connector_purchase_state: 'delivered', start_date: start, end_date: end,
          error_message: '',
          connector_affiliate_pending: documents.length === order.quantity,
        } }, { session });
        if (changed.modifiedCount !== 1) return;
        // Transaction rollback prevents ACTIVE-without-proxies and partially inserted deliveries.
        // Mongoose may attach insert/validation state to input objects. A transaction
        // callback can run again after write conflicts: give each attempt fresh docs.
        await this.proxies.insertMany(documents.map(document => ({ ...document })), { session, ordered: true });
        delivered = true;
      });
      return { delivered, ...(delivered ? { quantity: documents.length } : {}) };
    } finally { await session.endSession(); }
  }
}
