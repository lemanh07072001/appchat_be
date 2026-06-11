import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { SettingsService } from './settings.service';

@Controller('api/admin/payment-settings')
@UseGuards(AuthGuard, AdminGuard)
export class SettingsAdminController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getPaymentSettings() {
    return this.settingsService.getPaymentSettings();
  }

  @Patch()
  updatePaymentSettings(
    @Body() body: { bank_enabled?: boolean; binance_pay_enabled?: boolean },
  ) {
    return this.settingsService.updatePaymentSettings(body);
  }
}
