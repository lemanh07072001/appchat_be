import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateServiceDto } from '../dto/create-service.dto';
import { publicOrderConfig } from '../countries/country-policy';
import { resolveProduct, validateProductMapping } from './product-mapping';
import { ServicesService } from './services.service';
import { OrdersService } from '../orders/orders.service';

describe('selectable provider product mapping', () => {
  const service = { id_service: 'legacy', isp: [
    { name: 'FPT FP1', code: 'fpt_fp1', provider_product_id: 'fp1', provider_isp: 'FPT', duration_ids: { '7': 'fp1-week' } },
    { name: 'FPT FP2', code: 'fpt_fp2', provider_product_id: 'fp2', provider_isp: 'FPT' },
  ] };
  it('resolves exact variant and duration without any lookup', () => {
    expect(resolveProduct(service, 'fpt_fp1', 7, 'homeproxy')).toMatchObject({ product_id: 'fp1-week', provider_isp: 'FPT' });
    expect(resolveProduct(service, 'fpt_fp1', 30, 'homeproxy').product_id).toBe('fp1');
    expect(resolveProduct(service, 'fpt_fp2', 7, 'homeproxy').product_id).toBe('fp2');
  });
  it.each([undefined, 'FPT FP1', 'FPT_FP1', 'fpt'])('rejects absent or nonexact mapped selection %s', input => {
    expect(() => resolveProduct(service, input, 7)).toThrow();
  });
  it('requires exact duration when declared without default, including zero', () => {
    const configured = { id_service: 'must-not-fallback', isp: [{ name: 'FPT', code: 'fp', duration_ids: { '0': 'unlimited' } }] };
    expect(resolveProduct(configured, undefined, 0).product_id).toBe('unlimited');
    expect(() => resolveProduct(configured, 'fp', 7)).toThrow('no product');
  });
  it('retains legacy names, unlisted ISP and connector behavior', () => {
    expect(resolveProduct({ isp: [{ name: 'FPT', code: 'fpt' }] }, 'FPT', 30, 'proxyvn').product_id).toBe('fpt');
    expect(resolveProduct({}, 'Viettel_custom', 30, 'twoproxy').product_id).toBe('Viettel_custom');
    expect(resolveProduct({ id_service: 'base', duration_ids: { '30': 'month' } }, undefined, 30).product_id).toBe('month');
  });
  it('rejects invalid HomeProxy mapped enum before network access', () => {
    expect(() => resolveProduct({ isp: [{ name: 'Bad', code: 'variant', provider_product_id: 'id' }] }, 'variant', 30, 'homeproxy')).toThrow('provider_isp');
  });
  it.each(['-1', '1.5', '01', '__proto__', '9007199254740992'])('rejects unsafe duration key %s', key => {
    expect(() => validateProductMapping({ isp: [{ name: 'FPT', code: 'fp', duration_ids: { [key]: 'id' } }] })).toThrow();
  });
  it('rejects duplicate opaque codes and blank IDs', () => {
    expect(() => validateProductMapping({ isp: [...service.isp, service.isp[0]] })).toThrow('unique');
    expect(() => validateProductMapping({ isp: [{ name: 'FPT', code: 'fp', provider_product_id: ' ' }] })).toThrow();
  });
  it('validates nested DTO input', async () => {
    const dto = plainToInstance(CreateServiceDto, { name: 'Service', isp: [{ name: 'FPT', code: 'fp', provider_isp: 1, duration_ids: { '7': '' } }] });
    expect((await validate(dto)).some(e => e.property === 'isp')).toBe(true);
  });
  it('strips private snapshots from public config', () => {
    expect(publicOrderConfig({ isp: 'fpt_fp1', product_mapping: resolveProduct(service, 'fpt_fp1', 7) })).toEqual({ isp: 'fpt_fp1' });
  });
  it('validates merged service updates before saving', async () => {
    const document = { toObject: () => service, save: jest.fn(), markModified: jest.fn() };
    const services: any = Object.create(ServicesService.prototype);
    services.serviceModel = { findById: () => ({ exec: async () => document }) };
    await expect(services.update('id', { isp: [...service.isp, service.isp[0]] })).rejects.toThrow('unique');
    expect(document.save).not.toHaveBeenCalled();
    await expect(services.update('id', { duration_ids: { '-1': 'bad' } })).rejects.toThrow('duration_ids');
    expect(document.save).not.toHaveBeenCalled();
  });
  it('public service ISP entries expose only name and code', () => {
    const services: any = Object.create(ServicesService.prototype);
    const output = services.applyUserDiscount({ isp: service.isp }, null);
    expect(output.isp).toEqual(service.isp.map(({ name, code }) => ({ name, code })));
  });
  it('renew/refetch use immutable product but HomeProxy renewal keeps its category', () => {
    const orders: any = Object.create(OrdersService.prototype);
    const order = { order_type: 'static', config: { product_mapping: resolveProduct(service, 'fpt_fp1', 7) } };
    expect(orders.deriveIdService('proxyvn', order, { id_service: 'changed' })).toBe('fp1-week');
    expect(orders.deriveIdServiceForRenew('gpnip', order, { id_service: 'changed' })).toBe('fp1-week');
    expect(orders.deriveIdServiceForRenew('homeproxy', order, {})).toBe('1');
    expect(orders.deriveIdServiceForRenew('homeproxy', { ...order, order_type: 'rotating' }, {})).toBe('2');
    expect(orders.deriveIdService('other', { config: {} }, { id_service: 'legacy' })).toBe('legacy');
  });
});
