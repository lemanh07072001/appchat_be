import { BadRequestException } from '@nestjs/common';
import { registerDecorator } from 'class-validator';

export interface ServiceIsp {
  name: string;
  code: string;
  provider_product_id?: string;
  provider_isp?: string;
  duration_ids?: Record<string, string>;
}

function nonempty(value: any): boolean { return typeof value === 'string' && value.trim().length > 0; }
export function validDurationIds(value: any): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([key, id]) => /^(0|[1-9]\d*)$/.test(key) && Number.isSafeInteger(Number(key)) && nonempty(id));
}
export function DurationIds(): PropertyDecorator {
  return (target, propertyName) => registerDecorator({ name: 'durationIds', target: target.constructor,
    propertyName: String(propertyName), validator: { validate: validDurationIds,
      defaultMessage: () => 'duration_ids must map safe nonnegative integer days to nonempty product IDs' } });
}
export function validateProductMapping(service: any): void {
  if (service.duration_ids !== undefined && !validDurationIds(service.duration_ids))
    throw new BadRequestException('Invalid duration_ids');
  if (service.isp === undefined) return;
  if (!Array.isArray(service.isp)) throw new BadRequestException('Invalid ISP choices');
  const codes = new Set<string>();
  for (const entry of service.isp) {
    if (!entry || !nonempty(entry.name) || !nonempty(entry.code) || codes.has(entry.code))
      throw new BadRequestException('ISP names and unique codes are required');
    codes.add(entry.code);
    for (const key of ['provider_product_id', 'provider_isp']) {
      if (entry[key] !== undefined && !nonempty(entry[key])) throw new BadRequestException(`Invalid ${key}`);
    }
    if (entry.duration_ids !== undefined && !validDurationIds(entry.duration_ids)) throw new BadRequestException('Invalid ISP duration_ids');
  }
}

export interface ProductSnapshot {
  product_id: string;
  provider_isp: string;
  selection?: string;
  product_id_configured: boolean;
}

/** Pure: resolves only the already-loaded service. Customer codes are opaque. */
export function resolveProduct(service: any, input?: string, days?: number, provider?: string): ProductSnapshot {
  const choices: ServiceIsp[] = service.isp ?? [];
  let entry = choices.find(e => e.code === input);
  // Name aliases are retained only for old, unmapped choices.
  if (!entry && input) entry = choices.find(e => e.name === input && e.provider_product_id === undefined && e.duration_ids === undefined && e.provider_isp === undefined);
  if (choices.length && !entry) {
    if (!input && choices.length === 1) entry = choices[0];
    else throw new BadRequestException(input ? 'Unknown ISP selection' : 'ISP selection required');
  }
  const mapped = !!entry && (entry.provider_product_id !== undefined || entry.duration_ids !== undefined || entry.provider_isp !== undefined);
  const isp = entry?.provider_isp ?? entry?.code ?? input ?? '';
  const durationId = days === undefined ? undefined : entry?.duration_ids?.[String(days)];
  let product = durationId ?? entry?.provider_product_id;
  if (mapped && product === undefined) throw new BadRequestException('Selected ISP has no product for this duration');
  if (mapped && provider === 'homeproxy' && !(service.type === 'rotating' ? ['HOMEPROXY'] : ['FPT', 'VNPT', 'VIETTEL']).includes(isp.toUpperCase()))
    throw new BadRequestException('Invalid HomeProxy provider_isp');
  const serviceDuration = days === undefined ? undefined : service.duration_ids?.[String(days)];
  const configured = mapped || !!serviceDuration;
  if (!mapped) product = serviceDuration || String(service.id_service ?? '').trim();
  if (!configured && provider === 'homeproxy' && (isp || service.type === 'rotating')) {
    product = service.type === 'rotating' ? ({ 1: '27508e13-4341-4feb-b10c-b92f08d94798', 7: '32b77236-78ae-4e9a-91c6-eac1352d9945', 30: '608e026f-46a5-42cd-9839-e62419999da0' }[days ?? -1]) :
      ({ vnpt: 'ab734ade-8bc6-4a70-b783-d9b31d7df36c', viettel: '6422b0e2-1d86-443e-bf7f-5031e6b74f66', fpt: 'c94584fb-60ac-4f26-82f8-d3dc1e425169' }[isp.toLowerCase()]);
    if (!product) throw new BadRequestException('Unsupported HomeProxy ISP or duration');
  } else if (!configured && ['proxyvn', 'twoproxy'].includes(provider ?? '')) product = isp;
  if (!configured && provider === 'gpnip') {
    try { const body = JSON.parse(service.body_api || '{}'); product = String(body.packageId ?? body.id ?? product); } catch {}
  }
  return { product_id: product ?? '', provider_isp: isp, selection: entry?.code ?? input, product_id_configured: configured };
}

export function productProviderParams(snapshot: ProductSnapshot) {
  return { id_service: snapshot.product_id, isp: snapshot.provider_isp, product_id_configured: snapshot.product_id_configured };
}
