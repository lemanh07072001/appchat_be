import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConnectorAccount } from './connector-account.schema';
import { ConnectorSecrets } from './connector-secrets.service';
import { ProviderConnectorsService } from './provider-connectors.service';
import { ConnectorHttp } from './connector-http.service';
import { validateConnectorResult } from './connector-contract';
import { assertPurchasePackage } from './connector-purchase-policy';

/** Internal runtime. No public arbitrary-input endpoint and no paid actions. */
@Injectable()
export class ConnectorRuntime {
  constructor(@InjectModel(ConnectorAccount.name) private readonly accounts: Model<ConnectorAccount>,
    private readonly connectors: ProviderConnectorsService,
    private readonly secrets: ConnectorSecrets, private readonly http: ConnectorHttp) {}

  /** Fixed-input catalog preview, safe to expose to administrators. */
  async catalog(accountId: string) {
    const { result, definition } = await this.readContext(accountId, 'catalog', {});
    const buy = definition.actions?.buy;
    const operation = buy && 'operation' in buy ? definition.operations[buy.operation] : undefined;
    const identities = new Map<unknown, number>();
    for (const item of result.items ?? []) identities.set(item.id, (identities.get(item.id) ?? 0) + 1);
    const eligibility = (item: Record<string, unknown>) => {
      if (!operation || operation.effect !== 'write' || !operation.response || !operation.output) {
        return { purchaseEligible: false, purchaseBlocker: 'Mẫu chưa có thao tác mua trực tiếp với mapping kết quả.' };
      }
      if (identities.get(item.id) !== 1) {
        return { purchaseEligible: false, purchaseBlocker: 'Mã gói bị trùng trong danh mục nhà cung cấp.' };
      }
      try { assertPurchasePackage(definition.purchasePolicy, item); }
      catch { return { purchaseEligible: false, purchaseBlocker: 'Gói không đáp ứng ràng buộc mua của mẫu kết nối.' }; }
      return { purchaseEligible: true };
    };
    // Catalog UI receives product fields only, never arbitrary mapped proxy credentials.
    return { items: (result.items ?? []).map(item => ({ id: item.id, name: item.name,
      ...(typeof item.price === 'number' && Number.isFinite(item.price) && item.price >= 0 ? { price: item.price } : {}),
      ...(typeof item.currency === 'string' ? { currency: item.currency } : {}),
      ...eligibility(item),
    })) };
  }

  async read(accountId: string, action: 'catalog' | 'fetch' | 'usage', input: Record<string, unknown>,
    pinned?: { connectorCode: string; connectorVersion: number }) {
    return (await this.readContext(accountId, action, input, pinned)).result;
  }

  private async readContext(accountId: string, action: 'catalog' | 'fetch' | 'usage', input: Record<string, unknown>,
    pinned?: { connectorCode: string; connectorVersion: number }) {
    if (!Types.ObjectId.isValid(accountId) || !['catalog', 'fetch', 'usage'].includes(action)) {
      throw new BadRequestException('Invalid provider read action');
    }
    const account = await this.accounts.findById(accountId).select('+credential').lean().exec();
    if (!account?.enabled) throw new BadRequestException('Connector account unavailable');
    if (pinned && (account.connectorCode !== pinned.connectorCode || account.connectorVersion !== pinned.connectorVersion)) {
      throw new BadRequestException('Pinned connector account/version unavailable');
    }
    const definition = await this.connectors.publishedDefinition(account.connectorCode, account.connectorVersion);
    if (!definition) throw new BadRequestException('Published connector version required');
    const token = this.secrets.decrypt(account.credential, new Types.ObjectId(accountId).toHexString());
    const result = validateConnectorResult(action, await this.http.readMapped(definition, action, input, token));
    return { definition, result };
  }
}
