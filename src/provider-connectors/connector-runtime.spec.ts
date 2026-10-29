import { ConnectorRuntime } from './connector-runtime.service';
import { homeproxyPurchaseCandidate } from './homeproxy-template';

describe('Account-bound generic runtime', () => {
  function fixture() {
    const query = { select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn() };
    const accounts = { findById: jest.fn().mockReturnValue(query) };
    const connectors = { publishedDefinition: jest.fn().mockResolvedValue({}) };
    const secrets = { decrypt: jest.fn().mockReturnValue('secret') };
    const http = { readMapped: jest.fn().mockResolvedValue({ fields: { used_gb: 1 } }) };
    query.exec.mockResolvedValue({ enabled: true, connectorCode: 'example', connectorVersion: 2, credential: {} });
    return { query, accounts, connectors, secrets, http, runtime: new ConnectorRuntime(accounts as any, connectors as any, secrets as any, http as any) };
  }
  const id = '507f1f77bcf86cd799439011';
  it('pins execution to the account version and keeps the key out of mapped inputs', async () => {
    const f = fixture();
    expect(await f.runtime.read(id, 'usage', { orderId: 'x' })).toEqual({ fields: { used_gb: 1 } });
    expect(f.connectors.publishedDefinition).toHaveBeenCalledWith('example', 2);
    expect(f.http.readMapped).toHaveBeenCalledWith({}, 'usage', { orderId: 'x' }, 'secret');
  });
  it('refuses disabled accounts, missing versions and paid actions', async () => {
    const f = fixture();
    await expect(f.runtime.read(id, 'buy' as any, {})).rejects.toThrow();
    expect(f.accounts.findById).not.toHaveBeenCalled();
    f.query.exec.mockResolvedValue({ enabled: false });
    await expect(f.runtime.read(id, 'usage', {})).rejects.toThrow('unavailable');
    expect(f.http.readMapped).not.toHaveBeenCalled();
  });
  it('exposes a fixed-input catalog with product fields only', async () => {
    const f = fixture();
    f.http.readMapped.mockResolvedValue({ fields: {}, items: [{ id: 'p1', name: 'Package', price: 10, currency: 'USD', password: 'do-not-expose', metadata: 'private' }] } as any);
    expect(await f.runtime.catalog(id)).toEqual({ items: [{ id: 'p1', name: 'Package', price: 10, currency: 'USD',
      purchaseEligible: false, purchaseBlocker: expect.any(String) }] });
    expect(f.http.readMapped).toHaveBeenCalledWith({}, 'catalog', {}, 'secret');
  });
  it('does not return invalid product prices and refuses unpublished configurations', async () => {
    const f = fixture();
    f.http.readMapped.mockResolvedValue({ fields: {}, items: [{ id: 'p1', name: 'Package', price: -1 }] } as any);
    expect(await f.runtime.catalog(id)).toEqual({ items: [{ id: 'p1', name: 'Package',
      purchaseEligible: false, purchaseBlocker: expect.any(String) }] });
    f.connectors.publishedDefinition.mockResolvedValue(null as any);
    await expect(f.runtime.catalog(id)).rejects.toThrow('Published');
  });
  it('refuses reads when an order-pinned version differs from the current account', async () => {
    const f = fixture();
    await expect(f.runtime.read(id, 'fetch', { orderId: 'paid-order' }, { connectorCode: 'example', connectorVersion: 1 })).rejects.toThrow('Pinned');
    expect(f.http.readMapped).not.toHaveBeenCalled();
    expect(f.secrets.decrypt).not.toHaveBeenCalled();
  });
  it('calculates eligibility on the exact read version without exposing policy fields or credentials', async () => {
    const f = fixture();
    f.connectors.publishedDefinition.mockResolvedValue(homeproxyPurchaseCandidate());
    const product = { id: 'eligible', name: 'VIETTEL', provider: 'VIETTEL', categoryType: 1,
      billingUnit: 'ngày', statusId: 1, password: 'private-value' };
    f.http.readMapped.mockResolvedValue({ fields: {}, items: [product, { ...product, id: 'wrong', provider: 'VNPT' },
      { id: 'missing', name: 'Combo' }, { ...product, id: 'disabled', statusId: 2 }] } as any);
    const result = await f.runtime.catalog(id);
    expect(result.items[0]).toEqual({ id: 'eligible', name: 'VIETTEL', purchaseEligible: true });
    expect(result.items.slice(1).every(item => !item.purchaseEligible && item.purchaseBlocker)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(JSON.stringify(result)).not.toContain('billingUnit');
    expect(f.connectors.publishedDefinition).toHaveBeenCalledTimes(1);
  });
  it('blocks duplicate identities even when each item individually satisfies policy', async () => {
    const f = fixture();
    f.connectors.publishedDefinition.mockResolvedValue(homeproxyPurchaseCandidate());
    const product = { id: 'duplicate', name: 'VIETTEL', provider: 'VIETTEL', categoryType: 1, billingUnit: 'ngày', statusId: 1 };
    f.http.readMapped.mockResolvedValue({ fields: {}, items: [product, product] } as any);
    expect((await f.runtime.catalog(id)).items.every(item => item.purchaseEligible === false)).toBe(true);
  });
});
