import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../schemas/orders.schema';
import { OrderStatusEnum, PaymentStatusEnum } from '../enum/order.enum';
import { AffiliateService } from '../affiliate/affiliate.service';

/** Durable post-delivery work. AffiliateService has a unique order commission fence. */
@Injectable()
export class ConnectorFulfillmentEffects {
  constructor(@InjectModel(Order.name) private readonly orders: Model<OrderDocument>,
    private readonly affiliate: AffiliateService) {}

  async reconcile(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) return false;
    const filter = { _id: new Types.ObjectId(orderId), connector_purchase: { $ne: null },
      connector_purchase_state: 'delivered', connector_affiliate_pending: true,
      status: OrderStatusEnum.ACTIVE, payment_status: PaymentStatusEnum.PAID };
    const order = await this.orders.findOne(filter).exec();
    // No commission for shortages or refunded/cancelled orders.
    if (!order || order.actual_quantity !== order.quantity || order.quantity < 1 || order.refunded_amount > 0) return false;
    await this.affiliate.handleOrderActive(order, true);
    const saved = await this.orders.updateOne({ ...filter, actual_quantity: order.actual_quantity,
      quantity: order.quantity, refunded_amount: order.refunded_amount }, { $set: { connector_affiliate_pending: false } });
    return saved.modifiedCount === 1;
  }
}
