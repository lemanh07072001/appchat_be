import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Partner } from '../schemas/partners.schema';
import { ConnectorAccount } from './connector-account.schema';
import { ProviderConnectorsService } from './provider-connectors.service';
import { ConnectorSecrets } from './connector-secrets.service';

/** Copies only into a new disabled account. Never edits legacy keys, services or orders. */
@Injectable()
export class ConnectorCredentialMigration {
  constructor(@InjectModel(Partner.name) private readonly partners: Model<Partner>,
    @InjectModel(ConnectorAccount.name) private readonly accounts: Model<ConnectorAccount>,
    private readonly connectors: ProviderConnectorsService, private readonly secrets: ConnectorSecrets) {}

  async copy(partnerId: string, body: { connectorCode: string; connectorVersion: number; expectedOrigin: string }) {
    if (!Types.ObjectId.isValid(partnerId) || !body ||
        Object.keys(body).some(key => !['connectorCode', 'connectorVersion', 'expectedOrigin'].includes(key)) ||
        typeof body.connectorCode !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(body.connectorCode) ||
        !Number.isSafeInteger(body.connectorVersion) || body.connectorVersion < 1 || typeof body.expectedOrigin !== 'string') {
      throw new BadRequestException('Invalid credential migration request');
    }
    const definition = await this.connectors.publishedDefinition(body.connectorCode, body.connectorVersion);
    if (!definition || new URL(definition.baseUrl).origin !== body.expectedOrigin) {
      throw new BadRequestException('Published template and explicit provider origin confirmation required');
    }
    const source = new Types.ObjectId(partnerId);
    const publicResult = (row: any) => {
      if (row.connectorCode !== body.connectorCode || row.connectorVersion !== body.connectorVersion) {
        throw new ConflictException('Credential already copied to another template; existing account preserved');
      }
      return { accountId: String(row._id), connectorCode: row.connectorCode, connectorVersion: row.connectorVersion,
        enabled: row.enabled === true, legacyUnchanged: true, servicesUnchanged: true, ordersUnchanged: true };
    };
    const existing = await this.accounts.findOne({ legacyPartnerId: source }).lean().exec();
    if (existing) return publicResult(existing);
    const partner = await this.partners.findById(source).select('name token_api').lean().exec();
    if (!partner) throw new NotFoundException('Provider not found');
    const token = partner.token_api?.trim();
    if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new BadRequestException('Legacy credential unavailable or invalid');
    const id = new Types.ObjectId();
    const credential = this.secrets.encrypt(token, id.toHexString());
    try {
      const row = await this.accounts.create({ _id: id, name: partner.name, legacyPartnerId: source,
        connectorCode: body.connectorCode, connectorVersion: body.connectorVersion, credential, enabled: false });
      return publicResult(row);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const winner = await this.accounts.findOne({ legacyPartnerId: source }).lean().exec();
      if (!winner) throw new ConflictException('Concurrent credential migration; reload before retrying');
      return publicResult(winner);
    }
  }
}
