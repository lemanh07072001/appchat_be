import { Injectable, SetMetadata, applyDecorators } from '@nestjs/common';

export const PROXY_PROVIDER_CODE = 'proxy_provider_code';

/**
 * Đánh dấu một class là adapter nhà cung cấp và gắn luôn `partner.code` của nó.
 *
 * `ProxyProviderFactory` quét metadata này lúc khởi động, nên thêm nhà cung cấp
 * mới chỉ còn HAI bước: tạo file adapter với decorator này, và khai class trong
 * `ProxyProvidersModule.providers[]` để Nest dựng instance.
 *
 * Trước đây phải sửa bốn chỗ (file adapter, constructor của factory, một dòng
 * `registry.set`, và module) — quên bất kỳ chỗ nào cũng chỉ vỡ lúc chạy.
 */
export const ProxyProvider = (code: string) =>
  applyDecorators(Injectable(), SetMetadata(PROXY_PROVIDER_CODE, code));
