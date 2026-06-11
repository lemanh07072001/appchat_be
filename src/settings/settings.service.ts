import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PaymentSettings,
  PaymentSettingsDocument,
} from '../schemas/payment-settings.schema';

@Injectable()
export class SettingsService {
  constructor(
    @InjectModel(PaymentSettings.name)
    private readonly paymentSettingsModel: Model<PaymentSettingsDocument>,
  ) {}

  async getPaymentSettings(): Promise<PaymentSettingsDocument> {
    let settings = await this.paymentSettingsModel.findOne().exec();
    if (!settings) {
      settings = new this.paymentSettingsModel({
        bank_enabled: true,
        binance_pay_enabled: true,
      });
      await settings.save();
    }
    return settings;
  }

  async updatePaymentSettings(dto: {
    bank_enabled?: boolean;
    binance_pay_enabled?: boolean;
  }): Promise<PaymentSettingsDocument> {
    const settings = await this.getPaymentSettings();
    if (dto.bank_enabled !== undefined) settings.bank_enabled = dto.bank_enabled;
    if (dto.binance_pay_enabled !== undefined)
      settings.binance_pay_enabled = dto.binance_pay_enabled;
    return settings.save();
  }
}
