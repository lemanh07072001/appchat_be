import { ConnectorMigrationPreview } from './connector-migration-preview.service';
import { OrderStatusEnum } from '../enum/order.enum';

describe('Read-only provider migration inventory', () => {
  const id = '507f1f77bcf86cd799439011';
  function fixture() {
    const partner = { _id: id, name: 'HomeProxy', code: 'homeproxy', status: true, token_api: 'SECRET-DO-NOT-RETURN' };
    const service: any = { _id: id, name: 'Product', status: true, pricing_mode: 'duration',
      pricing: { '30': { price: 100, cost: 50 } }, id_service: 'old-product', api_enabled: true, allow_renew: true };
    const rows: any[] = [];
    const query = (result: unknown) => {
      const q: any = { exec: jest.fn().mockResolvedValue(result) };
      for (const name of ['select', 'lean', 'sort', 'limit']) q[name] = jest.fn().mockReturnValue(q);
      return q;
    };
    const partners = { findById: jest.fn().mockReturnValue(query(partner)) };
    const services = { find: jest.fn().mockReturnValue(query([service])) };
    const orders = { aggregate: jest.fn().mockReturnValue(query(rows)) };
    return { partner, service, rows, partners, services, orders,
      preview: new ConnectorMigrationPreview(partners as any, services as any, orders as any) };
  }
  it('returns explicit blockers without credentials, prices or account binding details', async () => {
    const f = fixture(); f.service.connector_binding = { accountId: 'private-account' };
    const result = await f.preview.preview(id);
    expect(result).toMatchObject({ readOnly: true, canMigrate: false, canRemoveLegacyAdapter: false,
      provider: { hasCredential: true } });
    expect(result.services[0]).toMatchObject({ durations: [30], alreadyBound: true });
    expect(result.services[0].blockers).toContain('already-bound-preserve-existing-binding');
    const serialized = JSON.stringify(result);
    for (const secret of ['SECRET-DO-NOT-RETURN', 'private-account', '"cost"', '"price"']) expect(serialized).not.toContain(secret);
  });
  it('requires reconciliation even for FAILED or pending-refund legacy purchases', async () => {
    const f = fixture();
    f.rows.push({ _id: { status: OrderStatusEnum.FAILED, connector: false }, count: 2 },
      { _id: { status: OrderStatusEnum.PENDING_REFUND, connector: false }, count: 3 },
      { _id: { status: OrderStatusEnum.EXPIRED, connector: false }, count: 4 },
      { _id: { status: OrderStatusEnum.ACTIVE, connector: true }, count: 1 });
    const result = await f.preview.preview(id);
    expect(result.orders).toEqual({ total: 10, legacy: 9, connector: 1, legacyRequiringReview: 5 });
    expect(result.blockers).toContain('legacy-orders-require-reconciliation');
    expect(result.blockers).toContain('legacy-order-history-must-be-preserved');
  });
  it('flags absent keys and unsupported service pricing without modifying records', async () => {
    const f = fixture(); f.partner.token_api = ''; f.service.pricing_mode = 'bandwidth';
    f.service.id_service = ''; f.service.pricing = { bad: {} };
    const result = await f.preview.preview(id);
    expect(result.blockers).toContain('missing-credential');
    expect(result.services[0].blockers).toEqual(expect.arrayContaining(['bandwidth-checkout-not-supported',
      'missing-legacy-package', 'invalid-duration-price-table', 'verified-template-and-catalog-match-required']));
    expect(f.service.api_enabled).toBe(true);
  });
  it('rejects invalid and absent providers', async () => {
    const f = fixture();
    await expect(f.preview.preview('invalid')).rejects.toThrow('Invalid provider ID');
    expect(f.partners.findById).not.toHaveBeenCalled();
    f.partners.findById.mockReturnValue({ select: () => ({ lean: () => ({ exec: async () => null }) }) } as any);
    await expect(f.preview.preview(id)).rejects.toThrow('Provider not found');
  });
});
