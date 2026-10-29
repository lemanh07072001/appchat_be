import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { ConnectorDispatch } from './connector-dispatch.schema';
import { ConnectorSecrets } from './connector-secrets.service';
import { validateConnectorResult } from './connector-contract';
import { ConnectorAction } from './connector-definition';
import { mapConnectorOutput } from './connector-output';

export interface DispatchIdentity {
  reference: string;
  orderId: string;
  accountId: string;
  connectorCode: string;
  connectorVersion: number;
  action: string;
}

/** Stable fingerprint; inputs themselves (possibly proxy credentials) are never stored here. */
export function dispatchInputHash(input: unknown): string {
  const normalize = (value: unknown, depth: number): unknown => {
    if (depth > 15) throw new BadRequestException('Provider input nesting exceeds limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => normalize(item, depth + 1));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.keys(value).sort().map(key => {
        if (['__proto__', 'prototype', 'constructor', 'token', 'apiKey', 'token_api', 'credential'].includes(key)) {
          throw new BadRequestException('Unsafe provider input field');
        }
        return [key, normalize((value as Record<string, unknown>)[key], depth + 1)];
      }));
    }
    throw new BadRequestException('Unsupported provider input');
  };
  const serialized = JSON.stringify(normalize(input, 0));
  if (Buffer.byteLength(serialized) > 100_000) throw new BadRequestException('Provider input exceeds limit');
  return createHash('sha256').update(serialized).digest('hex');
}

/** Internal ledger primitive only. There is intentionally no admin dispatch endpoint. */
@Injectable()
export class ConnectorDispatches {
  constructor(@InjectModel(ConnectorDispatch.name) private readonly model: Model<ConnectorDispatch>,
    private readonly secrets: ConnectorSecrets) {}

  private normalizeIdentity(identity: DispatchIdentity): DispatchIdentity {
    if (!identity || !/^[a-zA-Z0-9:_-]{8,150}$/.test(identity.reference) ||
        Object.keys(identity).some(key => !['reference', 'orderId', 'accountId', 'connectorCode', 'connectorVersion', 'action'].includes(key)) ||
        !Types.ObjectId.isValid(identity.orderId) || !Types.ObjectId.isValid(identity.accountId) ||
        !/^[a-z][a-z0-9_-]{1,63}$/.test(identity.connectorCode) ||
        !Number.isSafeInteger(identity.connectorVersion) || identity.connectorVersion < 1 ||
        !['buy', 'renew', 'rotate', 'cancel', 'topup', 'password', 'allowedIps'].includes(identity.action)) {
      throw new BadRequestException('Invalid provider dispatch identity');
    }
    return { ...identity, orderId: new Types.ObjectId(identity.orderId).toHexString(), accountId: new Types.ObjectId(identity.accountId).toHexString() };
  }

  async claim(identity: DispatchIdentity, input: Record<string, unknown>) {
    identity = this.normalizeIdentity(identity);
    const inputHash = dispatchInputHash(input);
    try {
      const row = await this.model.create({ ...identity, inputHash, owner: randomUUID(), status: 'claimed' });
      return { acquired: true as const, id: String(row._id), owner: row.owner, status: row.status };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const row = await this.model.findOne({ reference: identity.reference }).lean().exec();
      if (!row || Object.entries(identity).some(([key, value]) => row[key] !== value) || row.inputHash !== inputHash) {
        throw new ConflictException('Dispatch reference already bound to different request');
      }
      // Even a crashed pre-submission claim cannot be automatically reacquired.
      return { acquired: false as const, id: String(row._id), status: row.status };
    }
  }

  async submitted(id: string, owner: string) { return this.transition(id, owner, 'claimed', 'submitted'); }
  async complete(id: string, owner: string) { return this.transition(id, owner, 'submitted', 'completed'); }
  async unknown(id: string, owner: string) { return this.transition(id, owner, 'submitted', 'unknown'); }

  /** Save before projecting onto the order, so a failed order update cannot lose a paid result. */
  async saveResult(id: string, owner: string, result: ReturnType<typeof mapConnectorOutput>) {
    if (!Types.ObjectId.isValid(id) || !owner) throw new BadRequestException('Invalid dispatch ownership');
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > 1_000_000) throw new BadRequestException('Provider result exceeds recovery limit');
    const encryptedResult = this.secrets.encrypt(serialized, `dispatch:${new Types.ObjectId(id).toHexString()}`);
    const saved = await this.model.updateOne({ _id: id, owner, status: 'submitted', resultSavedAt: { $exists: false } },
      { $set: { encryptedResult, resultSavedAt: new Date() } });
    if (saved.modifiedCount !== 1) throw new ConflictException('Dispatch result already saved or ownership changed');
  }

  /** Internal reconciliation only. Exact identity required; does not release the dispatch fence. */
  async recoverResult(identity: DispatchIdentity, input?: Record<string, unknown>) {
    identity = this.normalizeIdentity(identity);
    const row = await this.model.findOne({ reference: identity.reference }).select('+encryptedResult').lean().exec();
    if (!row || Object.entries(identity).some(([key, value]) => row[key] !== value) ||
        (input !== undefined && row.inputHash !== dispatchInputHash(input))) {
      throw new ConflictException('Dispatch recovery identity mismatch');
    }
    if (!row.encryptedResult || !row.resultSavedAt) return null;
    const decoded = this.secrets.decrypt(row.encryptedResult, `dispatch:${String(row._id)}`);
    return { dispatchId: String(row._id), status: row.status,
      result: validateConnectorResult(row.action as ConnectorAction, JSON.parse(decoded)) };
  }

  private async transition(id: string, owner: string, from: string, to: string) {
    if (!Types.ObjectId.isValid(id) || typeof owner !== 'string' || !owner) throw new BadRequestException('Invalid dispatch ownership');
    const changes: Record<string, unknown> = { status: to };
    if (to === 'submitted') changes.submittedAt = new Date();
    if (to === 'completed') changes.completedAt = new Date();
    const result = await this.model.updateOne({ _id: id, owner, status: from }, { $set: changes });
    if (result.modifiedCount !== 1) throw new ConflictException('Dispatch ownership or state changed');
  }
}
