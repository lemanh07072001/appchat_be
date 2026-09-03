import { sanitizeProviderName } from './sanitize-provider.util';

/**
 * Hàm này là lớp chặn duy nhất giữa message lỗi của nhà cung cấp và mắt khách
 * hàng. Thiếu một tên trong regex là lộ nguồn hàng — đúng chuyện đã xảy ra với
 * OmoProxy: adapter ném "OmoProxy: ..." và nó đi thẳng ra thông báo gia hạn lỗi.
 */
describe('sanitizeProviderName', () => {
  it.each([
    'proxyvn',
    'proxyseller',
    'homeproxy',
    'twoproxy',
    '2proxy',
    'proxysieutoc',
    'proxyv6',
    'omoproxy',
    'omocaptcha',
  ])('che tên "%s"', (name) => {
    expect(sanitizeProviderName(`Lỗi từ ${name} khi gia hạn`)).toBe(
      'Lỗi từ nhà cung cấp khi gia hạn',
    );
  });

  it('che bất kể hoa thường — adapter viết "OmoProxy" chứ không phải "omoproxy"', () => {
    expect(sanitizeProviderName('OmoProxy: bậc gia hạn không khớp')).toBe(
      'nhà cung cấp: bậc gia hạn không khớp',
    );
  });

  it('che mọi lần xuất hiện, không chỉ lần đầu', () => {
    expect(sanitizeProviderName('homeproxy lỗi, thử proxyvn')).toBe(
      'nhà cung cấp lỗi, thử nhà cung cấp',
    );
  });

  it('rỗng / null → chuỗi rỗng, không ném lỗi', () => {
    expect(sanitizeProviderName('')).toBe('');
    expect(sanitizeProviderName(null)).toBe('');
    expect(sanitizeProviderName(undefined)).toBe('');
  });

  it('không đụng tới text bình thường', () => {
    const msg = 'Số dư không đủ để gia hạn';
    expect(sanitizeProviderName(msg)).toBe(msg);
  });
});
