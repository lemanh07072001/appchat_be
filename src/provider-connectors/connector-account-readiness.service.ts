import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConnectorAccount } from './connector-account.schema';
import { Service } from '../schemas/services.schema';
import { ProviderConnectorsService } from './provider-connectors.service';
import { connectorActionReadiness } from './connector-contract';
import { assertPurchaseProtocols, resolvePurchaseIsp, resolvePurchaseCountry } from './connector-purchase-policy';

/** Local setup diagnostics only. Does not verify API credentials or enable checkout. */
@Injectable()
export class ConnectorAccountReadiness {
  constructor(@InjectModel(ConnectorAccount.name) private readonly accounts: Model<ConnectorAccount>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    private readonly connectors: ProviderConnectorsService, private readonly config: ConfigService) {}

  async inspect(accountId: string) {
    if (!Types.ObjectId.isValid(accountId)) throw new BadRequestException('Invalid account ID');
    const id = new Types.ObjectId(accountId).toHexString();
    const account = await this.accounts.findById(id).select('_id enabled connectorCode connectorVersion legacyPartnerId sourcePartnerId predecessorAccountId').lean().exec();
    if (!account) throw new NotFoundException('Connector account not found');
    const definition = await this.connectors.publishedDefinition(account.connectorCode, account.connectorVersion);
    const sourcePartnerId = account.sourcePartnerId ?? account.legacyPartnerId;
    const actions = definition ? connectorActionReadiness(definition) : [];
    const blockers: string[] = [];
    if (account.predecessorAccountId && !sourcePartnerId) blockers.push('service-provider-review-required');
    if (!account.enabled) blockers.push('account-disabled');
    if (!definition) blockers.push('published-template-required');
    for (const action of ['check', 'catalog', 'buy', 'fetch'] as const) {
      const binding = definition?.actions[action];
      const op = binding && 'operation' in binding ? definition?.operations[binding.operation] : undefined;
      if (!op?.response || action !== 'check' && !op.output) {
        blockers.push(`${action}-mapping-required`); continue;
      }
      if (op.effect !== (action === 'buy' ? 'write' : 'read') || action === 'check' && op.method !== 'GET') {
        blockers.push(`${action}-mapping-required`); continue;
      }
      const fields = action === 'buy' ? op.output?.fields : op.output?.items?.fields;
      const required = action === 'buy' ? { provider_order_id: 'string' }
        : action === 'fetch' ? (definition?.purchasePolicy?.protocolMode === 'dual'
          ? { host: 'string', httpPort: 'number', socks5Port: 'number', username: 'string', password: 'string' }
          : { host: 'string', port: 'number', protocol: 'string', username: 'string', password: 'string' })
        : action === 'catalog' ? { id: 'string', name: 'string' } : {};
      if (Object.entries(required).some(([field, type]) => !fields?.[field]?.required || fields[field].type !== type)) {
        blockers.push(`${action}-mapping-required`);
      }
    }
    const bound = await this.services.find({ 'connector_binding.accountId': id })
      .select('_id status api_enabled pricing_mode pricing protocol isp country_choices partner connector_binding').limit(501).lean().exec();
    const matching = bound.filter(service => service.connector_binding?.connectorCode === account.connectorCode &&
      service.connector_binding?.connectorVersion === account.connectorVersion);
    const valid = matching.filter(service => {
      if (account.predecessorAccountId && !sourcePartnerId) return false;
      if (sourcePartnerId && String(service.partner ?? '') !== String(sourcePartnerId)) return false;
      const days = Object.keys(service.pricing ?? {});
      const packages = service.connector_binding?.packages;
      try { assertPurchaseProtocols(definition?.purchasePolicy, service.protocol ?? []); }
      catch { return false; }
      try {
        for (const packageId of Object.values(packages ?? {})) {
          if (service.country_choices?.length) {
            for (const choice of service.country_choices) resolvePurchaseCountry(definition?.purchasePolicy, choice.code, service.country_choices, packageId);
          } else resolvePurchaseCountry(definition?.purchasePolicy, undefined, [], packageId);
          if (service.isp?.length) {
            for (const choice of service.isp) resolvePurchaseIsp(definition?.purchasePolicy, choice.code, service.isp, packageId);
          } else resolvePurchaseIsp(definition?.purchasePolicy, undefined, [], packageId);
        }
      } catch { return false; }
      return !!definition && service.pricing_mode === 'duration' && days.length > 0 && days.length <= 100 &&
        !!packages && typeof packages === 'object' && !Array.isArray(packages) &&
        Object.keys(packages).length === days.length && days.every(day =>
        /^[1-9][0-9]{0,3}$/.test(day) && Number(day) <= 3650 &&
        Object.hasOwn(packages, day) && typeof packages[day] === 'string' && !!packages[day].trim() &&
        packages[day] === packages[day].trim() && packages[day].length <= 256);
    });
    if (matching.some(service => sourcePartnerId && String(service.partner ?? '') !== String(sourcePartnerId))) {
      blockers.push('service-provider-review-required');
    }
    if (matching.some(service => {
      try { assertPurchaseProtocols(definition?.purchasePolicy, service.protocol ?? []); return false; }
      catch { return true; }
    })) blockers.push('service-protocol-review-required');
    if (!bound.length) blockers.push('service-binding-required');
    if (bound.length > 500) blockers.push('service-inventory-truncated');
    if (valid.length !== bound.length) blockers.push('service-binding-review-required');
    const checkoutEnabled = this.config.get<string>('CONNECTOR_CHECKOUT_ENABLED') === 'true';
    if (!checkoutEnabled) blockers.push('checkout-disabled');
    return { readOnly: true, connectionVerified: false, requiresConnectionCheck: true,
      catalogVerified: false, durationLimitsVerified: false,
      checkoutEnabled, configurationReady: blockers.filter(reason => reason !== 'checkout-disabled').length === 0,
      // Static configuration cannot establish provider compatibility or safe activation.
      readyForLivePurchase: false, blockers, actions,
      services: { bound: Math.min(bound.length, 500), valid: valid.length,
        enabledForSale: valid.filter(service => service.status === true && service.api_enabled === true).length },
      supported: ['duration-pricing', 'authenticated-http-https-socks5'],
      unsupported: ['voucher', 'bandwidth-checkout', 'rotation-selection', 'country-specific-pricing', 'after-sale-operations'],
    };
  }
}
