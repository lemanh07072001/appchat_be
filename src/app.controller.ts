import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { featureFlags } from './common/feature-flags';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Công khai: FE đọc để ẩn/hiện nút nạp tiền, mua và gia hạn proxy.
  @Get('api/public/features')
  getFeatures() {
    return {
      deposit_enabled: featureFlags.depositEnabled,
      purchase_enabled: featureFlags.purchaseEnabled,
    };
  }
}
