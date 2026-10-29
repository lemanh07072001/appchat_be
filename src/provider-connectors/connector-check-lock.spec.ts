import type Redis from 'ioredis';
import { ConnectorCheckLock } from './connector-check-lock.service';

describe('Distributed connector connection-check lock', () => {
  it('uses expiring NX locks and owner-checked release', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) };
    const lock = new ConnectorCheckLock(redis as unknown as Redis);
    expect(await lock.run('account', async () => 'checked')).toBe('checked');
    expect(redis.set).toHaveBeenCalledWith('provider-connectors:check-lock:account', expect.any(String), 'EX', 90, 'NX');
    expect(redis.eval.mock.calls[0].slice(1)).toEqual([1, 'provider-connectors:check-lock:account', redis.set.mock.calls[0][1]]);
  });
  it('does not call upstream when another process owns the lock', async () => {
    const redis = { set: jest.fn().mockResolvedValue(null), eval: jest.fn() };
    const action = jest.fn();
    await expect(new ConnectorCheckLock(redis as unknown as Redis).run('account', action)).rejects.toThrow('already running');
    expect(action).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it('fails closed when Redis is unavailable', async () => {
    const redis = { set: jest.fn().mockRejectedValue(new Error('offline')) };
    const action = jest.fn();
    await expect(new ConnectorCheckLock(redis as unknown as Redis).run('account', action)).rejects.toThrow('Redis');
    expect(action).not.toHaveBeenCalled();
  });
  it('releases the lock when upstream fails', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) };
    await expect(new ConnectorCheckLock(redis as unknown as Redis).run('account', async () => { throw new Error('upstream'); })).rejects.toThrow('upstream');
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });
});
