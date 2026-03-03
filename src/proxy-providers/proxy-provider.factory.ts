import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { IProxyProvider } from './proxy-provider.interface';
import { Proxyv6Provider } from './impl/proxyv6.provider';
import { HomeproxyProvider } from './impl/homeproxy.provider';
// import { ProxysellerProvider } from './impl/proxyseller.provider';

/**
 * Factory resolve đúng provider theo partner.code.
 *
 * Để thêm nhà cung cấp mới:
 *   1. Tạo file src/proxy-providers/impl/<name>.provider.ts
 *   2. Inject vào constructor bên dưới
 *   3. Thêm 1 dòng this.registry.set('<code>', this.<name>) trong onModuleInit()
 *   4. Đăng ký provider trong ProxyProvidersModule.providers[]
 */
@Injectable()
export class ProxyProviderFactory implements OnModuleInit {
  private readonly registry = new Map<string, IProxyProvider>();

  constructor(
    private readonly proxyv6:     Proxyv6Provider,
    private readonly homeproxy:   HomeproxyProvider,
    // private readonly proxyseller: ProxysellerProvider,
  ) {}

  onModuleInit() {
    this.registry.set('proxyv6',   this.proxyv6);
    this.registry.set('homeproxy', this.homeproxy);
    // this.registry.set('proxyseller', this.proxyseller);
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
