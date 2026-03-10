import { Module } from '@nestjs/common';
import { ProxyProviderFactory } from './proxy-provider.factory';
import { Proxyv6Provider } from './impl/proxyv6.provider';
import { HomeproxyProvider } from './impl/homeproxy.provider';
import { ProxyvnProvider } from './impl/proxyvn.provider';
import { ProxysieutocProvider } from './impl/proxysieutoc.provider';
// import { ProxysellerProvider } from './impl/proxyseller.provider';

@Module({
  providers: [
    ProxyProviderFactory,
    Proxyv6Provider,
    HomeproxyProvider,
    ProxyvnProvider,
    ProxysieutocProvider,
    // ProxysellerProvider,
  ],
  exports: [ProxyProviderFactory],
})
export class ProxyProvidersModule {}
