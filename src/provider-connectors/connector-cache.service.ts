import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ConnectorDefinition, validateConnectorDefinition } from './connector-definition';

@Injectable()
export class ConnectorCache {
  private readonly inflight = new Map<string, Promise<ConnectorDefinition | null>>();
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async published(code: string, version: number, load: () => Promise<ConnectorDefinition | null>) {
    // Immutable published versions only. No keys, balances or execution outcomes.
    const key = `provider-connectors:v1:${code}:${version}`;
    const pending = this.inflight.get(key);
    if (pending) return structuredClone(await pending);
    const promise = this.load(key, load);
    this.inflight.set(key, promise);
    try { return structuredClone(await promise); }
    finally { this.inflight.delete(key); }
  }

  private async load(key: string, load: () => Promise<ConnectorDefinition | null>) {
    try {
      const cached = await this.redis.get(key);
      if (cached) return validateConnectorDefinition(JSON.parse(cached));
    } catch { /* Redis outage or invalid cache: MongoDB remains authoritative. */ }
    const value = await load();
    if (!value) return null;
    const validated = validateConnectorDefinition(value);
    try { await this.redis.set(key, JSON.stringify(validated), 'EX', 300); }
    catch { /* Cache availability must not prevent configuration reads. */ }
    return validated;
  }
}
