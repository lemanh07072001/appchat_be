import { BadGatewayException, BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConnectorAccount } from './connector-account.schema';
import { ProviderConnectorsService } from './provider-connectors.service';
import { ConnectorSecrets } from './connector-secrets.service';
import { ConnectorHttp } from './connector-http.service';
import { readWorkflowPath } from '../proxy-providers/workflows/provider-workflow';
import { connectorSucceeded } from './connector-success';

@Injectable()
export class ConnectorAccountsService {
  private readonly checking = new Set<string>();
  constructor(@InjectModel(ConnectorAccount.name) private readonly accounts: Model<ConnectorAccount>,
    private readonly connectors: ProviderConnectorsService,
    private readonly secrets: ConnectorSecrets, private readonly http: ConnectorHttp) {}

  list() {
    return this.accounts.find().select('_id name connectorCode connectorVersion enabled revision createdAt updatedAt')
      .sort({ createdAt: -1 }).limit(500).lean().exec();
  }

  async update(id: string, body: { revision: number; enabled?: boolean; apiKey?: string }) {
    if (!Types.ObjectId.isValid(id) || !body || !Number.isSafeInteger(body.revision) || body.revision < 0 ||
        Object.keys(body).some(key => !['revision', 'enabled', 'apiKey'].includes(key)) ||
        (body.enabled === undefined && body.apiKey === undefined) ||
        (body.enabled !== undefined && typeof body.enabled !== 'boolean')) throw new BadRequestException('Invalid account update');
    const changes: Record<string, unknown> = {};
    if (body.enabled !== undefined) changes.enabled = body.enabled;
    if (body.apiKey !== undefined) {
      if (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 8192 || /[\r\n]/.test(body.apiKey)) {
        throw new BadRequestException('Invalid API key');
      }
      changes.credential = this.secrets.encrypt(body.apiKey.trim(), new Types.ObjectId(id).toHexString());
    }
    const result = await this.accounts.findOneAndUpdate({ _id: id, revision: body.revision },
      { $set: changes, $inc: { revision: 1 } }, { new: true })
      .select('_id name connectorCode connectorVersion enabled revision').lean().exec();
    if (!result) throw new ConflictException('Account changed; reload before updating');
    return result;
  }

  async create(body: { name: string; connectorCode: string; connectorVersion: number; apiKey: string }) {
    if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 ||
        typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 8192 || /[\r\n]/.test(body.apiKey)) {
      throw new BadRequestException('Invalid account name or API key');
    }
    const definition = await this.connectors.publishedDefinition(body.connectorCode, body.connectorVersion);
    if (!definition) throw new BadRequestException('Published connector version required');
    const id = new Types.ObjectId();
    const credential = this.secrets.encrypt(body.apiKey.trim(), id.toHexString());
    await this.accounts.create({ _id: id, name: body.name.trim(), connectorCode: body.connectorCode,
      connectorVersion: body.connectorVersion, credential });
    return { id: id.toHexString(), name: body.name.trim(), connectorCode: body.connectorCode, connectorVersion: body.connectorVersion, enabled: true };
  }

  /** Old orders pin the account version. Upgrade by creating a disabled successor, never by rewriting it. */
  async upgrade(id: string, body: { revision: number; targetVersion: number }) {
    if (!Types.ObjectId.isValid(id) || !body || Object.keys(body).some(key => !['revision', 'targetVersion'].includes(key)) ||
        !Number.isSafeInteger(body.revision) || body.revision < 0 || !Number.isSafeInteger(body.targetVersion) || body.targetVersion < 1) {
      throw new BadRequestException('Invalid account upgrade');
    }
    const source = await this.accounts.findById(id).select('+credential').lean().exec();
    if (!source) throw new NotFoundException('Connector account not found');
    if (source.revision !== body.revision) throw new ConflictException('Account changed; reload before upgrading');
    if (body.targetVersion <= source.connectorVersion) throw new BadRequestException('A newer published version is required');
    const [previous, target] = await Promise.all([
      this.connectors.publishedDefinition(source.connectorCode, source.connectorVersion),
      this.connectors.publishedDefinition(source.connectorCode, body.targetVersion),
    ]);
    // Never silently send the existing secret to a different API destination/environment.
    if (!previous || !target || previous.baseUrl !== target.baseUrl || JSON.stringify(previous.auth) !== JSON.stringify(target.auth)) {
      throw new BadRequestException('Upgrade requires the same API destination and authentication; create a separate account otherwise');
    }
    const filter = { predecessorAccountId: new Types.ObjectId(id), connectorVersion: body.targetVersion };
    const sourcePartnerId = source.sourcePartnerId ?? source.legacyPartnerId;
    const result = (row: any) => ({ id: String(row._id), name: row.name, connectorCode: row.connectorCode,
      connectorVersion: row.connectorVersion, enabled: row.enabled === true, originalAccountUnchanged: true,
      servicesUnchanged: true, ordersUnchanged: true });
    const existing = await this.accounts.findOne(filter).lean().exec();
    if (existing) {
      if (sourcePartnerId && String(existing.sourcePartnerId ?? existing.legacyPartnerId ?? '') !== String(sourcePartnerId)) {
        throw new ConflictException('Successor source provider requires review');
      }
      return result(existing);
    }
    const successor = new Types.ObjectId();
    const credential = this.secrets.encrypt(this.secrets.decrypt(source.credential, new Types.ObjectId(id).toHexString()), successor.toHexString());
    try {
      return result(await this.accounts.create({ _id: successor, ...filter, name: `${source.name.slice(0, 170)} · v${body.targetVersion}`,
        connectorCode: source.connectorCode, credential, enabled: false, revision: 0,
        ...(sourcePartnerId ? { sourcePartnerId } : {}) }));
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const winner = await this.accounts.findOne(filter).lean().exec();
      if (!winner) throw new ConflictException('Concurrent account upgrade; reload before retrying');
      if (sourcePartnerId && String(winner.sourcePartnerId ?? winner.legacyPartnerId ?? '') !== String(sourcePartnerId)) {
        throw new ConflictException('Successor source provider requires review');
      }
      return result(winner);
    }
  }

  async check(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid account ID');
    if (this.checking.has(id)) throw new BadRequestException('Connection check already running');
    this.checking.add(id);
    try {
      const account = await this.accounts.findById(id).select('+credential').lean().exec();
      if (!account) throw new NotFoundException('Connector account not found');
      if (!account.enabled) throw new BadRequestException('Connector account disabled');
      const definition = await this.connectors.publishedDefinition(account.connectorCode, account.connectorVersion);
      const action = definition?.actions.check;
      const operation = action && 'operation' in action ? action.operation : undefined;
      const mapping = operation && definition?.operations[operation]?.response;
      if (!definition || !mapping) throw new BadRequestException('Connection check response mapping required');
      const token = this.secrets.decrypt(account.credential, new Types.ObjectId(id).toHexString());
      const started = Date.now();
      const response = await this.http.check(definition, token);
      if (!connectorSucceeded(response, mapping.success)) {
        return { ok: false, message: 'Provider did not confirm connection', latency_ms: Date.now() - started };
      }
      const info: { account?: string; balance?: number; currency?: string } = {};
      for (const field of ['account', 'balance', 'currency'] as const) {
        if (!mapping[field]) continue;
        const value = readWorkflowPath(response, mapping[field]!);
        if (field === 'balance') {
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadGatewayException('Invalid provider balance mapping');
          info.balance = value;
        } else {
          if (typeof value !== 'string' || value.length > 200 || value.includes(token)) throw new BadGatewayException('Invalid provider account mapping');
          info[field] = value;
        }
      }
      return { ok: true, latency_ms: Date.now() - started, ...info };
    } finally { this.checking.delete(id); }
  }
}
