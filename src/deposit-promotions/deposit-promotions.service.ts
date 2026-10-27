import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { assertDepositEnabled } from '../common/commerce-policy';
import { DepositIntent, DepositPromotionCatalog, PromotionQuote } from './deposit-promotions.schema';

export function vnd(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new BadRequestException('Amount must be a safe integer VND value');
  }
  return value;
}

export function calculateQuote(amount: number, program?: any): PromotionQuote {
  vnd(amount, 10_000);
  const tier = program?.tiers.filter((t: any) => t.minAmount <= amount)
    .sort((a: any, b: any) => b.minAmount - a.minAmount)[0];
  const rate = tier?.rate ?? 0;
  // Rates have at most two decimal places. BigInt avoids multiplication rounding.
  const bonusAmount = program ? Number(
    [BigInt(amount) * BigInt(Math.round(rate * 100)) / BigInt(10_000), BigInt(program.maxBonus)]
      .reduce((a, b) => a < b ? a : b),
  ) : 0;
  const totalAmount = vnd(amount + bonusAmount);
  return { promotionId: program?._id ?? null, promotionName: program?.name ?? null, rate, bonusAmount, totalAmount, amount };
}

export function intentEligible(intent: any, userId: string, amount: number, date: Date): boolean {
  // Bank providers report whole seconds. Accept the issuance second even when
  // intent creation stored milliseconds; expiry retains its exact timestamp.
  const issuedSecond = Math.floor(new Date(intent.issuedAt).getTime() / 1000) * 1000;
  return intent.userId.toString() === userId && intent.quote.amount === amount &&
    Number.isFinite(date.getTime()) && date.getTime() >= issuedSecond && date <= new Date(intent.expiresAt);
}

@Injectable()
export class DepositPromotionsService {
  constructor(
    @InjectModel(DepositPromotionCatalog.name) private readonly catalogs: Model<DepositPromotionCatalog>,
    @InjectModel(DepositIntent.name) private readonly intents: Model<DepositIntent>,
  ) {}

  async list() {
    return (await this.catalogs.findById('programs').lean().exec())?.programs ?? [];
  }

  async save(body: any, id?: string) {
    if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 ||
        !['draft', 'active', 'paused'].includes(body.status)) throw new BadRequestException('Invalid name or status');
    const start = new Date(body.start), end = new Date(body.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      throw new BadRequestException('Invalid start/end interval');
    }
    vnd(body.maxBonus);
    if (!Array.isArray(body.tiers) || !body.tiers.length || body.tiers.length > 100) throw new BadRequestException('Tiers required (maximum 100)');
    const tiers = body.tiers.map((t: any) => {
      vnd(t.minAmount);
      if (typeof t.rate !== 'number' || !Number.isFinite(t.rate) || t.rate < 0 || t.rate > 100 ||
          Math.abs(t.rate * 100 - Math.round(t.rate * 100)) > 1e-8) throw new BadRequestException('Rate must be 0–100 percent with at most two decimals');
      return { minAmount: t.minAmount, rate: t.rate };
    }).sort((a: any, b: any) => a.minAmount - b.minAmount);
    if (new Set(tiers.map((t: any) => t.minAmount)).size !== tiers.length) throw new BadRequestException('Duplicate tier minimum');
    const program = { _id: id ?? new Types.ObjectId().toString(), name: body.name.trim(), start, end, status: body.status, tiers, maxBonus: body.maxBonus };
    await this.edit((programs) => {
      if (id && !programs.some(p => p._id === id)) throw new NotFoundException('Promotion not found');
      const others = programs.filter(p => p._id !== program._id);
      if (program.status === 'active' && others.some(p => p.status === 'active' && new Date(p.start) < end && new Date(p.end) > start)) {
        throw new ConflictException('An active promotion already overlaps this interval');
      }
      return [...others, program];
    });
    return program;
  }

  private async edit(change: (programs: any[]) => any[]) {
    try {
      await this.catalogs.updateOne({ _id: 'programs' }, { $setOnInsert: { revision: 0, programs: [] } }, { upsert: true }).exec();
    } catch (e: any) { if (e.code !== 11000) throw e; }
    for (let n = 0; n < 20; n++) {
      const catalog = await this.catalogs.findById('programs').lean().exec();
      const programs = change(catalog!.programs);
      const result = await this.catalogs.updateOne({ _id: 'programs', revision: catalog!.revision }, { $set: { programs }, $inc: { revision: 1 } }).exec();
      if (result.modifiedCount) return;
    }
    throw new ConflictException('Concurrent promotion edit; retry');
  }

  async remove(id: string) {
    await this.edit(programs => {
      if (!programs.some(p => p._id === id)) throw new NotFoundException('Promotion not found');
      return programs.filter(p => p._id !== id);
    });
    return { id, deleted: true };
  }

  async quote(amount: number) {
    const now = new Date();
    const program = (await this.list()).find(p => p.status === 'active' && new Date(p.start) <= now && now < new Date(p.end));
    return calculateQuote(amount, program);
  }

  async createIntent(userId: string, amount: number) {
    assertDepositEnabled();
    const now = new Date();
    const terms = (await this.list()).find(p => p.status === 'active' && new Date(p.start) <= now && now < new Date(p.end)) ?? null;
    const quote = calculateQuote(amount, terms);
    const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + 15 * 60_000);
    const intent = await this.intents.create({ userId: new Types.ObjectId(userId), quote, terms, issuedAt, expiresAt, code: `DPI${randomBytes(12).toString('hex').toUpperCase()}` });
    return { ...quote, id: intent._id.toString(), code: intent.code, expiresAt };
  }

  code(content: string): string | null {
    const codes = content.toUpperCase().match(/DPI[0-9A-F]{24}/g) ?? [];
    if (codes.length > 1) throw new BadRequestException('Multiple deposit intent references');
    return codes[0] ?? null;
  }

  async findIntent(content: string) {
    const code = this.code(content);
    return code ? this.intents.findOne({ code }).lean().exec() : null;
  }

  async claim(content: string, userId: string, amount: number, date: Date, receiptId: string): Promise<PromotionQuote> {
    const code = this.code(content);
    if (!code) return calculateQuote(amount);
    const intent = await this.intents.findOne({ code }).lean().exec();
    if (!intent) throw new BadRequestException('Unknown deposit intent');
    if (intent.userId.toString() !== userId || intent.quote.amount !== amount) throw new BadRequestException('Intent user or actual amount mismatch');
    if (!intentEligible(intent, userId, amount, date)) return calculateQuote(amount);
    const claimed = await this.intents.findOneAndUpdate({ _id: intent._id, $or: [{ consumedBy: null }, { consumedBy: receiptId }] }, { $set: { consumedBy: receiptId } }, { new: true }).lean().exec();
    if (!claimed) throw new ConflictException('Intent already used by another transfer');
    return intent.quote;
  }
}
