import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ProxyProviderFactory } from './proxy-provider.factory';
import { Proxyv6Provider } from './impl/proxyv6.provider';
import { HomeproxyProvider } from './impl/homeproxy.provider';
import { ProxyvnProvider } from './impl/proxyvn.provider';
import { ProxysieutocProvider } from './impl/proxysieutoc.provider';
import { TwoProxyProvider } from './impl/2proxy.provider';
import { ProxysellerProvider } from './impl/proxyseller.provider';
import { OmocaptchaProvider } from './impl/omocaptcha.provider';

/**
 * Thêm nhà cung cấp mới: tạo adapter với `@ProxyProvider('<code>')` rồi thêm
 * class vào `providers[]` bên dưới. Factory tự quét metadata, không còn danh
 * sách chép tay ở chỗ thứ ba để quên.
 */
@Module({
  // DiscoveryModule cho factory quét metadata của các adapter.
  imports: [DiscoveryModule],
  providers: [
    ProxyProviderFactory,
    OmocaptchaProvider,
    Proxyv6Provider,
    HomeproxyProvider,
    ProxyvnProvider,
    ProxysieutocProvider,
    TwoProxyProvider,
    ProxysellerProvider,
  ],
  exports: [ProxyProviderFactory],
})
export class ProxyProvidersModule {}
