// Ẩn danh tính nhà cung cấp (NCC) khỏi mọi chuỗi trả ra cho user:
// thay tên NCC (proxyvn, homeproxy, proxyseller, ...) bằng "nhà cung cấp".
// Dùng chung cho error message gia hạn, order log, và bất kỳ text user thấy được.
export const PROVIDER_NAME_RE =
  /\b(proxyvn|proxyseller|proxy-seller|homeproxy|home-proxy|twoproxy|2proxy|proxysieutoc|proxyv6|proxy\.vn)\b/gi;

/** Thay mọi tên NCC trong `text` bằng "nhà cung cấp". Rỗng/null → chuỗi rỗng. */
export function sanitizeProviderName(text?: string | null): string {
  if (!text) return '';
  return String(text).replace(PROVIDER_NAME_RE, 'nhà cung cấp');
}
