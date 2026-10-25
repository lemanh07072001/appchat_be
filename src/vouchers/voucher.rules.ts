import { BadRequestException } from '@nestjs/common';

export const RECEIPT_CAP = 10000;
export const RESERVATION_CAP = 10000;
export const AUDIT_CAP = 1000;
export const normalizeCode = (code: string) => String(code ?? '').trim().toUpperCase();
export function integer(value: any, name: string, min = 1): number {
  if (!Number.isSafeInteger(value) || value < min) throw new BadRequestException(`${name} must be a safe integer >= ${min}`);
  return value;
}
export function validateVoucher(body: any) {
  const code = normalizeCode(body.code);
  if (!/^[A-Z0-9_-]{1,64}$/.test(code)) throw new BadRequestException('Invalid voucher code');
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) throw new BadRequestException('Invalid name');
  if (!['draft', 'active', 'paused', 'archived'].includes(body.status)) throw new BadRequestException('Invalid status');
  if (!['fixed', 'percentage'].includes(body.discountType)) throw new BadRequestException('Invalid discount type');
  const value = body.discountValue;
  if (body.discountType === 'fixed') integer(value, 'discountValue');
  else if (!Number.isFinite(value) || value <= 0 || value > 100 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) throw new BadRequestException('Percentage must be <= 100 with at most two decimals');
  const startsAt = new Date(body.startsAt), endsAt = new Date(body.endsAt);
  if (!Number.isFinite(+startsAt) || !Number.isFinite(+endsAt) || startsAt >= endsAt) throw new BadRequestException('Invalid date range');
  if (!['all', 'selected'].includes(body.scope)) throw new BadRequestException('Invalid scope');
  if (!Array.isArray(body.serviceIds) || body.serviceIds.length > 1000 || body.serviceIds.some((id: any) => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) throw new BadRequestException('Invalid serviceIds');
  const serviceIds = [...new Set<string>(body.serviceIds.map((id: string) => id.toLowerCase()))];
  if (body.scope === 'selected' && !serviceIds.length) throw new BadRequestException('Select at least one service');
  return { code, name: body.name.trim(), status: body.status, startsAt, endsAt, discountType: body.discountType, discountValue: value,
    maxDiscount: integer(body.maxDiscount ?? Number.MAX_SAFE_INTEGER, 'maxDiscount'), minSubtotal: integer(body.minSubtotal ?? 0, 'minSubtotal', 0),
    scope: body.scope, serviceIds, totalLimit: integer(body.totalLimit, 'totalLimit'), perUserLimit: integer(body.perUserLimit, 'perUserLimit') };
}
export function discount(v: any, subtotal: number, serviceId: string, now = new Date()) {
  integer(subtotal, 'subtotal', 0);
  if (!v || v.status !== 'active' || +new Date(v.startsAt) > +now || +new Date(v.endsAt) <= +now || subtotal < v.minSubtotal ||
    (v.scope === 'selected' && !v.serviceIds.includes(serviceId))) throw new BadRequestException('Voucher is not applicable');
  const raw = v.discountType === 'fixed' ? BigInt(v.discountValue) : BigInt(subtotal) * BigInt(Math.round(v.discountValue * 100)) / 10000n;
  return Number(raw < BigInt(Math.min(subtotal, v.maxDiscount)) ? raw : BigInt(Math.min(subtotal, v.maxDiscount)));
}
export function missingRefund(total: number, quantity: number, actual: number) {
  integer(total, 'total', 0); integer(quantity, 'quantity'); integer(actual, 'actual', 0);
  if (actual > quantity) throw new BadRequestException('Invalid actual quantity');
  return Number(BigInt(total) * BigInt(quantity - actual) / BigInt(quantity));
}
export function fingerprint(payload: any): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v;
  return require('crypto').createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}
