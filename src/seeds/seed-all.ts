import * as mongoose from 'mongoose';
import { connect, SeedResult } from './lib/db';

import { seedBlog } from './modules/blog.seed';
import { seedAnnouncements } from './modules/announcements.seed';
import { seedChat } from './modules/chat.seed';
import { seedAffiliate } from './modules/affiliate.seed';
import { seedWallet } from './modules/wallet.seed';
import { seedDeposits } from './modules/deposits.seed';
import { seedWebhookLogs } from './modules/webhook.seed';
import { seedUserDemo, DEMO_TARGET } from './modules/user-demo.seed';
import { seedUsersBulk } from './modules/users-bulk.seed';
import { seedDownline } from './modules/downline.seed';
import { seedServices } from './modules/services.seed';

interface Step {
  name: string;
  run: () => Promise<SeedResult>;
}

/**
 * Thứ tự phụ thuộc:
 *   user demo (tài khoản referrer)  → downline → affiliate (commission tính từ đơn downline)
 *   deposits (transactions)         → webhook logs (steps trỏ transaction_id có thật)
 *   mọi thứ tạo đơn/giao dịch       → wallet (backfill ví từ đơn + giao dịch)
 */
const steps: Step[] = [
  { name: 'proxy services',      run: seedServices },
  { name: 'demo user account',   run: seedUserDemo },
  // Chinh tai khoan admin cung can du lieu: dang nhap vao ma trang don hang,
  // giao dich, nap tien deu rong thi khong kiem tra duoc gi.
  {
    name: 'admin account',
    run: () =>
      seedUserDemo({
        ...DEMO_TARGET,
        email: 'admin@fastproxyvn.com',
        orderPrefix: 'ORD-ADM-',
        txIdBase: 970001,
        topupCode: 'NAPAD100001',
        apiToken: 'fpx_live_ad11c7e5a2d80463b9c3e1f7a5d208b6',
        providerIdBase: 300000,
        // Downline da gan cho tai khoan demo; admin khong cuop lai.
        referralCount: 0,
      }),
  },
  { name: 'user hàng loạt',      run: seedUsersBulk },
  { name: 'downline + đơn',      run: seedDownline },
  { name: 'blog posts',          run: seedBlog },
  { name: 'announcements',       run: seedAnnouncements },
  { name: 'chat messages',       run: seedChat },
  { name: 'affiliate',           run: seedAffiliate },
  { name: 'bank transactions',   run: seedDeposits },
  { name: 'webhook logs',        run: seedWebhookLogs },
  { name: 'wallet transactions', run: seedWallet },
];

async function main() {
  await connect();
  console.log(`Connected: ${process.env.MONGO_URI}\n`);

  const totals = { created: 0, updated: 0, skipped: 0 };

  for (const step of steps) {
    const started = Date.now();
    const r = await step.run();
    totals.created += r.created;
    totals.updated += r.updated;
    totals.skipped += r.skipped;
    console.log(
      `${step.name.padEnd(22)} created=${String(r.created).padStart(4)}  ` +
        `updated=${String(r.updated).padStart(4)}  skipped=${String(r.skipped).padStart(4)}  ` +
        `(${Date.now() - started}ms)`,
    );
  }

  console.log(
    `\nTotal: created=${totals.created} updated=${totals.updated} skipped=${totals.skipped}`,
  );
  if (totals.created === 0 && totals.updated === 0) {
    console.log('Không có gì thay đổi — dữ liệu mẫu đã đầy đủ.');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nSeed thất bại:', err.message);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
