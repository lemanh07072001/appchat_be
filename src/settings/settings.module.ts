import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PaymentSettings,
  PaymentSettingsSchema,
} from '../schemas/payment-settings.schema';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { SettingsAdminController } from './settings-admin.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentSettings.name, schema: PaymentSettingsSchema },
    ]),
    JwtModule,
  ],
  controllers: [SettingsController, SettingsAdminController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
