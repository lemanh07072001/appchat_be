import { ConnectorCache } from './connector-cache.service';
import { validateConnectorDefinition } from './connector-definition';
import type Redis from 'ioredis';

const definition = {
  baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
  operations: { account: { method: 'GET', path: '/account', effect: 'read', timeoutMs: 10000 } },
  actions: { check: { operation: 'account' } },
};

describe('Connector definitions and Redis cache', () => {
  it('accepts declarative definitions and rejects embedded secrets and unsafe endpoints', () => {
    expect(validateConnectorDefinition(definition).actions.check).toBeDefined();
    for (const baseUrl of ['http://api.example.com', 'https://127.0.0.1', 'https://user:secret@api.example.com', 'https://metadata.internal']) {
      expect(() => validateConnectorDefinition({ ...definition, baseUrl })).toThrow();
    }
    expect(() => validateConnectorDefinition({ ...definition, auth: { type: 'bearer', token: 'secret' } })).toThrow();
    expect(() => validateConnectorDefinition({ ...definition, operations: { account: { ...definition.operations.account, path: '//other.example.com' } } })).toThrow();
    expect(() => validateConnectorDefinition({ ...definition, operations: { account: { ...definition.operations.account, effect: 'write' } } })).toThrow();
  });

  it('coalesces concurrent misses and caches immutable versions with a TTL', async () => {
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    const cache = new ConnectorCache(redis as unknown as Redis);
    const load = jest.fn().mockResolvedValue(definition);
    const [first, second] = await Promise.all([cache.published('example', 1, load), cache.published('example', 1, load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('provider-connectors:v1:example:1', JSON.stringify(definition), 'EX', 300);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('reads valid cached data without querying MongoDB', async () => {
    const redis = { get: jest.fn().mockResolvedValue(JSON.stringify(definition)), set: jest.fn() };
    const load = jest.fn();
    expect(await new ConnectorCache(redis as unknown as Redis).published('example', 1, load)).toEqual(definition);
    expect(load).not.toHaveBeenCalled();
  });

  it('falls back to MongoDB on Redis failure and does not cache missing versions', async () => {
    const redis = { get: jest.fn().mockRejectedValue(new Error('offline')), set: jest.fn().mockRejectedValue(new Error('offline')) };
    const cache = new ConnectorCache(redis as unknown as Redis);
    expect(await cache.published('example', 1, async () => validateConnectorDefinition(definition))).toEqual(definition);
    redis.set.mockClear();
    expect(await cache.published('example', 2, async () => null)).toBeNull();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
