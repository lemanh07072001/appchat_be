import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IProxyProvider } from './proxy-provider.interface';
import { Proxyv6Provider } from './impl/proxyv6.provider';
import { HomeproxyProvider } from './impl/homeproxy.provider';
import { ProxyvnProvider } from './impl/proxyvn.provider';
import { ProxysieutocProvider } from './impl/proxysieutoc.provider';
import { TwoProxyProvider } from './impl/2proxy.provider';
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

  private readonly logger = new Logger(ProxyProviderFactory.name);

  constructor(
    private readonly proxyv6:     Proxyv6Provider,
    private readonly homeproxy:   HomeproxyProvider,
    private readonly proxyvn:     ProxyvnProvider,
    private readonly proxysieutoc: ProxysieutocProvider,
    private readonly twoproxy: TwoProxyProvider,
    // private readonly proxyseller: ProxysellerProvider,
  ) {
    this.logger.warn('ProxyProviderFactory CONSTRUCTOR called — registry is empty until onModuleInit()');
  }

  onModuleInit() {
    try {
      this.registry.set('proxyv6',   this.proxyv6);
      this.registry.set('homeproxy', this.homeproxy);
      this.registry.set('proxyvn',   this.proxyvn);
      this.registry.set('proxysieutoc', this.proxysieutoc);
      this.registry.set('twoproxy', this.twoproxy);
      // this.registry.set('proxyseller', this.proxyseller);
      this.logger.log(`ProxyProviderFactory ready — providers: ${JSON.stringify([...this.registry.keys()])}`);
    } catch (err) {
      this.logger.error('ProxyProviderFactory onModuleInit failed', err?.stack);
      throw err;
    }
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
