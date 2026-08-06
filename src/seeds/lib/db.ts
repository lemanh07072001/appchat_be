import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

export interface SeedResult {
  created: number;
  updated: number;
  skipped: number;
}

export const emptyResult = (): SeedResult => ({ created: 0, updated: 0, skipped: 0 });

/** DB bắt buộc — chặn seed nhầm sang proxydb (default cũ của seed-transactions.ts) */
const EXPECTED_DB = 'fastproxy';

export async function connect(): Promise<typeof mongoose> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('Thiếu MONGO_URI trong .env — không đoán mặc định để tránh ghi nhầm DB.');
  }

  const dbName = uri.split('/').pop()?.split('?')[0] ?? '';
  if (dbName !== EXPECTED_DB) {
    throw new Error(
      `MONGO_URI trỏ tới DB "${dbName}" nhưng seed chỉ chạy trên "${EXPECTED_DB}". ` +
        'Sửa .env rồi chạy lại.',
    );
  }

  await mongoose.connect(uri);
  return mongoose;
}

/**
 * Upsert theo khoá tự nhiên — chạy lại nhiều lần không nhân bản dữ liệu.
 * Doc đã tồn tại thì giữ nguyên (đếm vào `skipped`), không ghi đè chỉnh sửa thủ công của admin.
 */
export async function insertIfAbsent<T extends Record<string, any>>(
  model: mongoose.Model<any>,
  docs: T[],
  keyOf: (doc: T) => Record<string, any>,
): Promise<SeedResult> {
  const result = emptyResult();

  for (const doc of docs) {
    const key = keyOf(doc);
    const existing = await model.findOne(key).select('_id').lean().exec();
    if (existing) {
      result.skipped++;
      continue;
    }
    await model.create(doc);
    result.created++;
  }

  return result;
}

/** PRNG có seed cố định (mulberry32) — mỗi lần chạy sinh cùng một bộ số. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rand: () => number, arr: T[]): T => arr[Math.floor(rand() * arr.length)];

export const intBetween = (rand: () => number, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));

/** Lùi `days` ngày kể từ `from` (mặc định: bây giờ). */
export function daysAgo(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
}

/** timestamps: true bỏ qua createdAt/updatedAt truyền vào — phải set lại bằng update thô. */
export async function forceTimestamps(
  model: mongoose.Model<any>,
  filter: Record<string, any>,
  createdAt: Date,
  updatedAt: Date = createdAt,
): Promise<void> {
  await model.collection.updateOne(filter, { $set: { createdAt, updatedAt } });
}
