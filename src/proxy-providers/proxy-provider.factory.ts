import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { IProxyProvider, ProviderCapabilities } from './proxy-provider.interface';
import { PROXY_PROVIDER_CODE } from './proxy-provider.decorator';

/**
 * Factory resolve đúng provider theo `partner.code`.
 *
 * Để thêm nhà cung cấp mới:
 *   1. Tạo file src/proxy-providers/impl/<name>.provider.ts, gắn
 *      `@ProxyProvider('<code>')` lên class
 *   2. Khai class đó trong `ProxyProvidersModule.providers[]`
 *
 * Registry tự dựng từ metadata của decorator lúc khởi động — không còn danh
 * sách chép tay để quên.
 */
@Injectable()
export class ProxyProviderFactory implements OnModuleInit {
  private readonly registry = new Map<string, IProxyProvider>();

  private readonly logger = new Logger(ProxyProviderFactory.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      // `instance` rỗng với provider dạng value/factory; `metatype` rỗng thì
      // không có chỗ nào để đọc metadata.
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object') continue;

      const target = wrapper.metatype ?? Object.getPrototypeOf(instance)?.constructor;
      if (!target) continue;

      const code = this.reflector.get<string>(PROXY_PROVIDER_CODE, target);
      if (!code) continue;

      const existing = this.registry.get(code);
      if (existing) {
        // Hai adapter cùng code là lỗi lập trình, và im lặng ghi đè thì đơn
        // hàng sẽ đi qua adapter sai mà không ai biết.
        throw new Error(
          `Hai adapter cùng đăng ký code "${code}": ` +
            `${existing.constructor?.name} và ${target.name}`,
        );
      }

      this.registry.set(code, instance as IProxyProvider);
    }

    if (this.registry.size === 0) {
      throw new Error(
        'ProxyProviderFactory: không tìm thấy adapter nào. ' +
          'Kiểm tra decorator @ProxyProvider và ProxyProvidersModule.providers[]',
      );
    }

    this.logger.log(
      `ProxyProviderFactory ready — providers: ${JSON.stringify([...this.registry.keys()].sort())}`,
    );
  }

  /**
   * Danh sách adapter đang có thật trong registry, kèm năng lực từng cái.
   *
   * Đây là nguồn duy nhất cho ô chọn adapter ở màn hình nhà cung cấp. Trước
   * đây admin gõ tay `partner.code`, lưu được cả code không tồn tại, và lỗi chỉ
   * nổ lúc khách bấm mua — sau khi đã hứa với khách.
   */
  listProviders(): {
    code: string;
    capabilities: ProviderCapabilities;
  }[] {
    return [...this.registry.entries()]
      .map(([code, provider]) => ({
        code,
        capabilities: {
          // Bốn cái bắt buộc phải do provider tự khai; không khai thì coi như đủ.
          buy:    provider.capabilities?.buy    ?? true,
          renew:  provider.capabilities?.renew  ?? true,
          rotate: provider.capabilities?.rotate ?? true,
          cancel: provider.capabilities?.cancel ?? true,
          // Mấy cái tuỳ chọn dò được bằng sự tồn tại của method.
          usage: typeof provider.fetchUsage === 'function',
          topup: typeof provider.extendBandwidth === 'function',
          check: typeof provider.checkConnection === 'function',
        },
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  /** Có adapter cho partner code này không (không ném lỗi). */
  hasProvider(partnerCode: string): boolean {
    return this.registry.has(partnerCode);
  }

  getProvider(partnerCode: string): IProxyProvider {
    const provider = this.registry.get(partnerCode);
    if (!provider) {
      throw new BadRequestException(
        `Chưa có provider cho partner code: "${partnerCode}". ` +
        `Kiểm tra ProxyProviderFactory.onModuleInit()`,
      );
    }
    return provider;
  }
}
