import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Service } from '../schemas/services.schema';
import { Order } from '../schemas/orders.schema';
import { ConnectorAccount } from './connector-account.schema';
import { ProviderConnectorsService } from './provider-connectors.service';
import { ConnectorRuntime } from './connector-runtime.service';
import { ConnectorSecrets } from './connector-secrets.service';
import { buildConnectorRequest } from './connector-request';
import { dispatchInputHash } from './connector-dispatch.service';
import { assertPurchasePackage, assertPurchaseProtocols, preparePurchaseCredentials, resolvePurchaseProtocol, resolvePurchaseIsp, resolvePurchaseCountry } from './connector-purchase-policy';

/** Admin package selection and checkout preparation; neither method can buy upstream. */
@Injectable()
export class ConnectorServiceBinding {
  constructor(@InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(ConnectorAccount.name) private readonly accounts: Model<ConnectorAccount>,
    private readonly connectors: ProviderConnectorsService, private readonly runtime: ConnectorRuntime,
    private readonly secrets: ConnectorSecrets) {}

  private async account(accountId: string) {
    if (!Types.ObjectId.isValid(accountId)) throw new BadRequestException('Invalid connector account');
    const account = await this.accounts.findById(accountId).select('+credential').lean().exec();
    if (!account?.enabled) throw new BadRequestException('Connector account unavailable');
    const definition = await this.connectors.publishedDefinition(account.connectorCode, account.connectorVersion);
    if (!definition) throw new BadRequestException('Published connector version required');
    for (const action of ['buy', 'fetch'] as const) {
      const binding = definition.actions[action];
      const op = binding && 'operation' in binding ? definition.operations[binding.operation] : undefined;
      if (!op?.response || !op.output || op.effect !== (action === 'buy' ? 'write' : 'read')) {
        throw new BadRequestException('Direct buy and fetch operations with success/output mappings required');
      }
      const fields = action === 'buy' ? op.output.fields : op.output.items?.fields;
      const required = action === 'buy' ? { provider_order_id: 'string' }
        : definition.purchasePolicy?.protocolMode === 'dual'
          ? { host: 'string', httpPort: 'number', socks5Port: 'number', username: 'string', password: 'string' }
          : { host: 'string', port: 'number', protocol: 'string', username: 'string', password: 'string' };
      for (const [field, type] of Object.entries(required)) {
        if (!fields?.[field]?.required || fields[field].type !== type) {
          throw new BadRequestException(`Required delivery mapping missing: ${field}`);
        }
      }
    }
    return { account, definition };
  }

  async bind(accountId: string, serviceId: string, body: { packages: Record<string, string> }) {
    if (!Types.ObjectId.isValid(serviceId)) throw new BadRequestException('Invalid service ID');
    const packages = body?.packages;
    if (!packages || typeof packages !== 'object' || Array.isArray(packages) ||
        Object.keys(packages).length < 1 || Object.keys(packages).length > 100 ||
        Object.entries(packages).some(([days, id]) => !/^[1-9][0-9]{0,3}$/.test(days) || Number(days) > 3650 ||
          typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 256)) {
      throw new BadRequestException('Select valid provider packages for each duration');
    }
    const service = await this.services.findById(serviceId).lean().exec();
    if (!service || service.pricing_mode !== 'duration') throw new BadRequestException('Duration service required');
    for (const days of Object.keys(service.pricing ?? {})) {
      if (!Object.hasOwn(packages, days)) throw new BadRequestException('Every sale duration needs a provider package');
    }
    if (Object.keys(packages).some(days => !Object.hasOwn(service.pricing ?? {}, days))) {
      throw new BadRequestException('Package duration is not in the sale price table');
    }
    const { account, definition } = await this.account(accountId);
    const sourcePartnerId = account.sourcePartnerId ?? account.legacyPartnerId;
    if (account.predecessorAccountId && !sourcePartnerId) {
      throw new BadRequestException('Successor source provider requires review before service binding');
    }
    if (sourcePartnerId && String(service.partner ?? '') !== String(sourcePartnerId)) {
      throw new BadRequestException('Service provider does not match the connector account source provider');
    }
    assertPurchaseProtocols(definition.purchasePolicy, service.protocol ?? []);
    const catalog = await this.runtime.read(accountId, 'catalog', {}, account);
    const ids = new Set((catalog.items ?? []).map(item => item.id));
    if (Object.values(packages).some(id => !ids.has(id))) throw new BadRequestException('Selected package is absent from provider catalog');
    for (const id of Object.values(packages)) {
      const matches = (catalog.items ?? []).filter(item => item.id === id);
      if (matches.length !== 1) throw new BadRequestException('Provider package identity is ambiguous');
      assertPurchasePackage(definition.purchasePolicy, matches[0]);
      if (service.country_choices?.length) {
        for (const choice of service.country_choices) resolvePurchaseCountry(definition.purchasePolicy, choice.code, service.country_choices, id);
      } else resolvePurchaseCountry(definition.purchasePolicy, undefined, [], id);
      if (definition.purchasePolicy?.isp && definition.purchasePolicy.isp.mode !== 'none') {
        for (const choice of service.isp ?? []) resolvePurchaseIsp(definition.purchasePolicy, choice.code, service.isp, id);
        if (!service.isp?.length) throw new BadRequestException('Configure service ISP options before binding');
      } else if (service.isp?.length) {
        throw new BadRequestException('Connector does not support service ISP options');
      }
    }
    const binding = { accountId: new Types.ObjectId(accountId).toHexString(), connectorCode: account.connectorCode,
      connectorVersion: account.connectorVersion, packages: { ...packages } };
    const saved = await this.services.updateOne({ _id: service._id, pricing: service.pricing,
      connector_binding: service.connector_binding ?? null,
       ...(definition.purchasePolicy ? { protocol: service.protocol } : {}),
        isp: service.isp ?? [],
        country_choices: service.country_choices ?? [],
      ...(sourcePartnerId ? { partner: service.partner } : {}) }, { $set: {
       connector_binding: binding, api_enabled: false, allow_renew: false,
       ...(definition.purchasePolicy?.protocolMode ? { connector_protocol_mode: definition.purchasePolicy.protocolMode }
         : service.connector_protocol_mode ? { connector_protocol_mode: null } : {}),
    } });
    if (saved.modifiedCount !== 1) throw new ConflictException('Service changed; reload before selecting packages');
    return { binding, purchaseEnabled: false };
  }

  /** Trusted pricing result only. Never spread customer config into the pinned input. */
  async prepare(binding: NonNullable<Service['connector_binding']>, options: {
    quantity: number; durationDays: number; protocol?: string; serviceProtocols?: string[]; username?: string; password?: string;
    isp?: string; serviceIsps?: { name: string; code: string }[];
    country?: string; serviceCountries?: { name: string; code: string }[];
  }): Promise<NonNullable<Order['connector_purchase']>> {
    if (!binding || !Number.isSafeInteger(options.quantity) || options.quantity < 1 || options.quantity > 1000 ||
        !Number.isSafeInteger(options.durationDays) || options.durationDays < 1 || options.durationDays > 3650 ||
        options.protocol !== undefined && !['http', 'https', 'socks5'].includes(options.protocol)) {
      throw new BadRequestException('Invalid Connector purchase selection');
    }
    const packageId = binding.packages?.[String(options.durationDays)];
    if (typeof packageId !== 'string' || !packageId.trim()) throw new BadRequestException('No provider package for this duration');
    const { account, definition } = await this.account(binding.accountId);
    if (account.connectorCode !== binding.connectorCode || account.connectorVersion !== binding.connectorVersion) {
      throw new ConflictException('Pinned connector account/version changed');
    }
    const protocol = resolvePurchaseProtocol(definition.purchasePolicy, options.protocol,
      options.serviceProtocols ?? (options.protocol ? [options.protocol] : []));
    const isp = resolvePurchaseIsp(definition.purchasePolicy, options.isp, options.serviceIsps ?? [], packageId);
    const country = resolvePurchaseCountry(definition.purchasePolicy, options.country, options.serviceCountries ?? [], packageId);
    const credentials = preparePurchaseCredentials(definition.purchasePolicy, { username: options.username, password: options.password });
    if (definition.purchasePolicy) {
      const catalog = await this.runtime.read(binding.accountId, 'catalog', {}, account);
      const matches = (catalog.items ?? []).filter(item => item.id === packageId);
      if (matches.length !== 1) throw new BadRequestException('Selected package is absent or ambiguous in provider catalog');
      assertPurchasePackage(definition.purchasePolicy, matches[0]);
    }
    const input = { packageId, quantity: options.quantity, durationDays: options.durationDays,
      ...(protocol !== undefined ? { protocol } : {}),
      ...(isp ? { isp: isp.value } : {}),
      ...(country ? { country: country.value } : {}),
      ...(credentials.username !== undefined ? { username: credentials.username } : {}),
      ...(credentials.password !== undefined ? { password: credentials.password } : {}) };
    dispatchInputHash(input);
    const token = this.secrets.decrypt(account.credential, new Types.ObjectId(binding.accountId).toHexString());
    const buy = definition.actions.buy! as { operation: string };
    buildConnectorRequest(definition, buy.operation, input, token);
    const fetch = definition.actions.fetch! as { operation: string };
    buildConnectorRequest(definition, fetch.operation, { ...input, orderId: 'preflight-order' }, token);
    return { accountId: binding.accountId, connectorCode: binding.connectorCode,
      connectorVersion: binding.connectorVersion, input,
      ...(isp ? { ispSelection: isp } : {}),
      ...(country ? { countrySelection: country } : {}),
      ...(definition.purchasePolicy?.protocolMode ? { protocolSelection: {
        mode: definition.purchasePolicy.protocolMode,
        protocols: protocol ? [protocol] : [...definition.purchasePolicy.protocols],
      } } : {}) };
  }
}
