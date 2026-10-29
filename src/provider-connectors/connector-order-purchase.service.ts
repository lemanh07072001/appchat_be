import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order } from '../schemas/orders.schema';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';
import { ConnectorAccount } from './connector-account.schema';
import { ConnectorSecrets } from './connector-secrets.service';
import { ProviderConnectorsService } from './provider-connectors.service';
import { ConnectorDispatches, dispatchInputHash } from './connector-dispatch.service';
import { ConnectorHttp } from './connector-http.service';
import { ConnectorWriteExecutor, preflightConnectorWrite } from './connector-write-executor';

/** Worker-only bridge. No endpoint, no automatic debit/refund, no legacy fallback. */
@Injectable()
export class ConnectorOrderPurchase {
  constructor(@InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(ConnectorAccount.name) private readonly accounts: Model<ConnectorAccount>,
    private readonly connectors: ProviderConnectorsService, private readonly secrets: ConnectorSecrets,
    private readonly dispatches: ConnectorDispatches, private readonly http: ConnectorHttp) {}

  /** Re-project durable accepted results only; never invokes HTTP or releases a fence. */
  async recover(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) throw new BadRequestException('Invalid order ID');
    const order = await this.orders.findById(orderId).lean().exec();
    const binding = order?.connector_purchase;
    if (!order || !binding || order.status !== OrderStatusEnum.PROCESSING ||
        order.payment_status !== PaymentStatusEnum.PAID || order.voucher_snapshot ||
        !['dispatching', 'reconciliation'].includes(order.connector_purchase_state ?? '')) return false;
    const recovered = await this.dispatches.recoverResult({ reference: `buy:${orderId.toLowerCase()}`, orderId,
      accountId: binding.accountId, connectorCode: binding.connectorCode, connectorVersion: binding.connectorVersion,
      action: 'buy' }, binding.input);
    // Submitted can still belong to a live executor. Leave it for explicit reconciliation
    // rather than racing the owner. Unknown/completed never re-dispatch automatically.
    if (!recovered || !['unknown', 'completed'].includes(recovered.status)) return false;
    const providerOrderId = recovered.result.fields.provider_order_id;
    if (order.provider_order_id && order.provider_order_id !== providerOrderId) {
      throw new ConflictException('Recovered provider order ID differs from saved order');
    }
    const saved = await this.orders.updateOne({ _id: order._id, status: OrderStatusEnum.PROCESSING,
      payment_status: PaymentStatusEnum.PAID, connector_purchase: binding,
      connector_purchase_state: order.connector_purchase_state, provider_order_id: order.provider_order_id },
    { $set: { provider_order_id: providerOrderId, connector_purchase_state: 'awaiting_delivery', error_message: '' } });
    return saved.modifiedCount === 1;
  }

  async purchase(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) throw new BadRequestException('Invalid order ID');
    const order = await this.orders.findById(orderId).lean().exec();
    const binding = order?.connector_purchase;
    if (!order || !binding || order.status !== OrderStatusEnum.PENDING ||
        order.payment_status !== PaymentStatusEnum.PAID || order.voucher_snapshot ||
        order.connector_purchase_state || order.provider_order_id) {
      throw new ConflictException('Connector purchase requires an unattempted paid order without voucher');
    }
    // Validate and hash the pinned inputs before taking the permanent order claim.
    dispatchInputHash(binding.input);
    if (!Types.ObjectId.isValid(binding.accountId)) throw new BadRequestException('Invalid connector account');
    const account = await this.accounts.findById(binding.accountId).select('+credential').lean().exec();
    if (!account?.enabled || account.connectorCode !== binding.connectorCode ||
        account.connectorVersion !== binding.connectorVersion) {
      throw new ConflictException('Pinned connector account/version unavailable');
    }
    const definition = await this.connectors.publishedDefinition(binding.connectorCode, binding.connectorVersion);
    if (!definition) throw new ConflictException('Published connector version required');
    const token = this.secrets.decrypt(account.credential, new Types.ObjectId(binding.accountId).toHexString());
    // Local validation must precede the order claim as well as the dispatch claim.
    // Invalid mappings/credentials have not reached upstream and need no reconciliation fence.
    preflightConnectorWrite(definition, 'buy', binding.input, token);
    const guard = { _id: order._id, status: OrderStatusEnum.PENDING, payment_status: PaymentStatusEnum.PAID,
      connector_purchase_state: null, provider_order_id: '', voucher_snapshot: null,
      connector_purchase: binding };
    const claimed = await this.orders.updateOne(guard, { $set: {
      status: OrderStatusEnum.PROCESSING, connector_purchase_state: 'dispatching',
    } });
    if (claimed.modifiedCount !== 1) throw new ConflictException('Order purchase claim changed');
    try {
      const executor = new ConnectorWriteExecutor(this.dispatches, this.http);
      return await executor.execute({ identity: { reference: `buy:${orderId.toLowerCase()}`, orderId,
        accountId: binding.accountId, connectorCode: binding.connectorCode,
        connectorVersion: binding.connectorVersion, action: 'buy' }, definition, input: binding.input, token,
        persistResult: async (_dispatchId, result) => {
          const saved = await this.orders.updateOne({ _id: order._id, status: OrderStatusEnum.PROCESSING,
            payment_status: PaymentStatusEnum.PAID, connector_purchase_state: 'dispatching', connector_purchase: binding },
          { $set: { provider_order_id: result.fields.provider_order_id, connector_purchase_state: 'awaiting_delivery', error_message: '' } });
          if (saved.modifiedCount !== 1) throw new ConflictException('Order result projection changed');
        } });
    } catch {
      // Keep paid funds and the dispatch fence: never hand this order to legacy refund/retry paths.
      await this.orders.updateOne({ _id: order._id, status: OrderStatusEnum.PROCESSING,
        connector_purchase_state: { $in: ['dispatching', 'awaiting_delivery'] } }, { $set: {
        connector_purchase_state: 'reconciliation', error_message: 'Giao dịch nhà cung cấp cần đối soát; không tự mua lại hoặc hoàn tiền.',
      } });
      throw new ConflictException('Connector purchase requires reconciliation');
    }
  }
}
