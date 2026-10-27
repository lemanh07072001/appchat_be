import 'reflect-metadata';
import { GpnipProvider } from '../src/proxy-providers/impl/gpnip.provider';

/**
 * Smoke test GPNIP bằng CHÍNH adapter của hệ thống (không phải curl), để biết
 * code đọc đúng response thật chứ không chỉ đúng với mock.
 *
 * CHỈ ĐỌC. Script này không có đường nào tạo đơn, nạp GB, gia hạn commit, đổi
 * mật khẩu hay đặt whitelist — những thứ đó tiêu tiền hoặc đổi cấu hình thật.
 * `POST /check-price` có gọi, vì tài liệu ghi rõ nó chỉ báo giá.
 *
 * Dùng:
 *   GPNIP_API_KEY=... GPNIP_BASE_URL=... npx ts-node scripts/gpnip-smoke.ts
 *
 * Key lấy từ env, không bao giờ nằm trong file này.
 */

const KEY = process.env.GPNIP_API_KEY?.trim();
if (!KEY) {
  console.error('Thiếu GPNIP_API_KEY');
  process.exit(1);
}

const mask = (k: string) => `${k.slice(0, 10)}…${k.slice(-4)} (${k.length} ký tự)`;
const short = (v: unknown, n = 600) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

let pass = 0;
let fail = 0;
let skip = 0;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const out = await fn();
    pass++;
    console.log(`\n✅ ${name}  (${Date.now() - t0}ms)`);
    console.log(`   ${short(out)}`);
    return out;
  } catch (err: any) {
    fail++;
    console.log(`\n❌ ${name}  (${Date.now() - t0}ms)`);
    console.log(`   ${err?.message ?? err}`);
    return null;
  }
}

async function main() {
  const provider = new GpnipProvider();
  console.log('='.repeat(72));
  console.log(`Base URL : ${GpnipProvider.resolveBaseUrl()}`);
  console.log(`API key  : ${mask(KEY!)}`);
  console.log('Chế độ   : CHỈ ĐỌC — không mua, không gia hạn, không đổi gì');
  console.log('='.repeat(72));

  // ─── 1. Tài khoản ─────────────────────────────────────────────────────────
  const me = await step('GET /me — checkConnection()', () =>
    provider.checkConnection(KEY!),
  );
  if (!me) {
    console.log('\nKey không dùng được ở base URL này — dừng, các bước sau vô nghĩa.');
    return summary();
  }

  // ─── 2. Danh mục gói ──────────────────────────────────────────────────────
  const pkgPage: any = await step('GET /packages — listPackages()', () =>
    provider.listPackages(KEY!, 1, 20),
  );

  const packages: any[] = Array.isArray(pkgPage?.data) ? pkgPage.data : [];
  console.log(`\n   → ${packages.length} gói ở trang 1, meta: ${short(pkgPage?.meta, 200)}`);
  for (const p of packages.slice(0, 10)) {
    console.log(
      `     #${p.id} ${p.title} | type=${p.type} delivery=${p.delivery} ` +
        `mode=${p.pricing?.mode} days=${p.duration_days} price=${p.price}`,
    );
  }

  // Lấy đúng 2 gói đầu để khỏi đốt rate limit 120 req/phút.
  for (const p of packages.slice(0, 2)) {
    await step(`GET /packages/${p.id}`, () =>
      (provider as any).request('GET', `/packages/${p.id}`, KEY!),
    );
    await step(`GET /packages/${p.id}/stock`, () =>
      (provider as any).request('GET', `/packages/${p.id}/stock`, KEY!),
    );
    // Báo giá — tài liệu: chỉ xem trước, KHÔNG tạo đơn và không trừ tiền.
    await step(`POST /check-price (#${p.id}) — chỉ báo giá`, () =>
      (provider as any).request('POST', '/check-price', KEY!, { id: p.id }),
    );
  }

  // ─── 3. Danh mục quốc gia ─────────────────────────────────────────────────
  for (const product of [
    'residential',
    'isp',
    'datacenter',
    'mobile',
    'residential-lite',
    'unlimited_residential',
  ]) {
    const list = await step(`GET /countries?product=${product}`, () =>
      provider.listCountries(KEY!, product),
    );
    if (list) {
      console.log(
        `   → NCC gọi là "${list.product}" · ${list.iso_codes.length} quốc gia` +
          (list.iso_codes.length
            ? `: ${list.iso_codes.slice(0, 8).join(', ')}…`
            : ''),
      );
    }
  }
  // Giá trị ngoài tài liệu phải bị adapter chặn TẠI CHỖ, không gửi đi.
  await step('GET /countries — chặn product sai (phải lỗi)', async () => {
    try {
      await provider.listCountries(KEY!, 'residential-plus');
      throw new Error('KHÔNG chặn — adapter sai');
    } catch (e: any) {
      if (e.message === 'KHÔNG chặn — adapter sai') throw e;
      return `đã chặn đúng: ${e.message}`;
    }
  });

  // ─── 4. Đơn phía nhà cung cấp ─────────────────────────────────────────────
  const orderPage: any = await step('GET /orders — listProviderOrders()', () =>
    provider.listProviderOrders(KEY!, 1, 20),
  );
  const orders: any[] = Array.isArray(orderPage?.data) ? orderPage.data : [];
  console.log(`\n   → ${orders.length} đơn ở trang 1, meta: ${short(orderPage?.meta, 200)}`);
  for (const o of orders.slice(0, 10)) {
    console.log(
      `     #${o.id} ${o.title ?? '—'} | status=${o.status}/${o.status_label} ` +
        `traffic=${o.traffic} usage=${o.usage} expired=${o.expired_at}`,
    );
  }

  if (!orders.length) {
    skip += 4;
    console.log(
      '\n⏭  Tài khoản chưa có đơn nào → bỏ qua GET /orders/{id}, /usage, /proxies, /geo.',
    );
    console.log('   (Chỉ test được 4 endpoint này khi có đơn thật; không tự mua để có.)');
    return summary();
  }

  const id = String(orders[0].id);
  await step(`GET /orders/${id} + /proxies — fetchOrderProxies()`, async () => {
    const proxies = await provider.fetchOrderProxies(KEY!, id);
    return proxies.length
      ? proxies.map((p) => `${p.host}:${p.port} (${p.protocol})`)
      : 'đơn chưa active → mảng rỗng (đúng thiết kế)';
  });
  await step(`GET /orders/${id}/usage — fetchUsage()`, () =>
    provider.fetchUsage(KEY!, id),
  );
  await step(`GET /orders/${id}/geo — fetchOrderGeo()`, () =>
    provider.fetchOrderGeo(KEY!, id),
  );
  await step(`GET /orders/${id}/proxies?format=json`, () =>
    (provider as any).request('GET', `/orders/${id}/proxies?format=json`, KEY!),
  );

  return summary();
}

function summary() {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`Kết quả: ${pass} pass · ${fail} fail · ${skip} skip`);
  console.log('Không có đơn nào được tạo, không có gì bị đổi.');
  console.log('='.repeat(72));
}

void main();
