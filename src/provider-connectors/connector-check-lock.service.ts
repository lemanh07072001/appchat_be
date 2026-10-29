import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class ConnectorCheckLock {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const key = `provider-connectors:check-lock:${id}`;
    const owner = randomUUID();
    let acquired: string | null;
    try { acquired = await this.redis.set(key, owner, 'EX', 90, 'NX'); }
    catch { throw new ServiceUnavailableException('Connection checks require Redis availability'); }
    if (acquired !== 'OK') throw new BadRequestException('Connection check already running');
    try { return await action(); }
    finally {
      try {
        await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, owner);
      } catch { /* Expiry releases the lock; never remove another owner's lock. */ }
    }
  }
}
