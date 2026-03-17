import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT          = 'REDIS_CLIENT';
/** Connection riêng cho blocking commands (BRPOP) — tránh block lệnh thường */
export const REDIS_BLOCKING_CLIENT = 'REDIS_BLOCKING_CLIENT';

function createRedisClient(config: ConfigService): Redis {
  return new Redis({
    host:     config.get<string>('REDIS_HOST', 'localhost'),
    port:     config.get<number>('REDIS_PORT', 6379),
    password: config.get<string>('REDIS_PASSWORD', ''),
    db:       Number(config.get('REDIS_DB') || 0),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createRedisClient(config),
    },
    {
      provide: REDIS_BLOCKING_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createRedisClient(config),
    },
  ],
  exports: [REDIS_CLIENT, REDIS_BLOCKING_CLIENT],
})
export class RedisModule {}
