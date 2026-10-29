import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Partner } from '../schemas/partners.schema';
import { Service } from '../schemas/services.schema';
import { Order } from '../schemas/orders.schema';
import { OrderStatusEnum } from '../enum/order.enum';

/** Read-only inventory. This deliberately cannot copy keys, bind services or rewrite orders. */
@Injectable()
export class ConnectorMigrationPreview {
  constructor(@InjectModel(Partner.name) private readonly partners: Model<Partner>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(Order.name) private readonly orders: Model<Order>) {}

  async preview(partnerId: string) {
    if (!Types.ObjectId.isValid(partnerId)) throw new BadRequestException('Invalid provider ID');
    const id = new Types.ObjectId(partnerId);
    const partner = await this.partners.findById(id).select('name code status token_api').lean().exec();
    if (!partner) throw new NotFoundException('Provider not found');
    const [services, statuses] = await Promise.all([
      this.services.find({ partner: id }).select('name status pricing_mode pricing id_service api_enabled allow_renew connector_binding')
        .sort({ _id: 1 }).limit(501).lean().exec(),
      this.orders.aggregate<{ _id: { status: number; connector: boolean }; count: number }>([
        { $match: { partner_id: id } },
        { $group: { _id: { status: '$status', connector: { $ne: [{ $ifNull: ['$connector_purchase', null] }, null] } }, count: { $sum: 1 } } },
      ]).exec(),
    ]);
    const terminal = new Set<number>([OrderStatusEnum.COMPLETED, OrderStatusEnum.EXPIRED,
      OrderStatusEnum.CANCELLED, OrderStatusEnum.REFUNDED]);
    const totals = { total: 0, legacy: 0, connector: 0, legacyRequiringReview: 0 };
    for (const row of statuses) {
      totals.total += row.count;
      if (row._id.connector) totals.connector += row.count;
      else {
        totals.legacy += row.count;
        // FAILED and PENDING_REFUND may hide an accepted upstream purchase.
        if (!terminal.has(row._id.status)) totals.legacyRequiringReview += row.count;
      }
    }
    const hasCredential = typeof partner.token_api === 'string' && partner.token_api.trim().length > 0;
    const blockers: string[] = [];
    if (!hasCredential) blockers.push('missing-credential');
    if (services.length > 500) blockers.push('service-inventory-truncated');
    if (totals.legacy > 0) blockers.push('legacy-order-history-must-be-preserved');
    if (totals.legacyRequiringReview > 0) blockers.push('legacy-orders-require-reconciliation');
    return {
      readOnly: true, canMigrate: false, canRemoveLegacyAdapter: false,
      provider: { id: String(partner._id), name: partner.name, code: partner.code,
        enabled: partner.status === true, hasCredential },
      blockers, orders: totals,
      services: services.slice(0, 500).map(service => {
        const reasons: string[] = [];
        if (service.connector_binding) reasons.push('already-bound-preserve-existing-binding');
        if (service.pricing_mode !== 'duration') reasons.push('bandwidth-checkout-not-supported');
        if (!service.id_service?.trim()) reasons.push('missing-legacy-package');
        const days = Object.keys(service.pricing ?? {});
        if (!days.length || days.some(day => !/^[1-9][0-9]{0,3}$/.test(day) || Number(day) > 3650)) {
          reasons.push('invalid-duration-price-table');
        }
        // Legacy package IDs are evidence only, never an automatic catalog match.
        reasons.push('verified-template-and-catalog-match-required');
        return { id: String(service._id), name: service.name, enabled: service.status === true,
          purchaseEnabled: service.api_enabled === true, renewEnabled: service.allow_renew === true,
          pricingMode: service.pricing_mode, legacyPackageId: service.id_service ?? '',
          durations: days.filter(day => /^[1-9][0-9]{0,3}$/.test(day) && Number(day) <= 3650).map(Number).sort((a, b) => a - b),
          alreadyBound: !!service.connector_binding, blockers: reasons };
      }),
      nextSteps: ['verify-provider-contract', 'create-versioned-template', 'copy-credential-without-overwrite',
        'verify-catalog-package-matches', 'reconcile-existing-orders-without-repurchase', 'explicit-cutover-after-validation'],
    };
  }
}
