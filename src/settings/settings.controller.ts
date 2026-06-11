import { Controller, Get } from '@nestjs/common';
import { SettingsService } from './settings.service';

// Public: user cần biết phương thức nạp nào đang bật để hiển thị "Bảo trì"
@Controller('api/payment-settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getPaymentSettings() {
    return this.settingsService.getPaymentSettings();
  }
}
