import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { AffiliateCommission, AffiliateCommissionSchema } from '../schemas/affiliate-commission.schema';
import { AffiliateConfig, AffiliateConfigSchema } from '../schemas/affiliate-config.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { Withdrawal, WithdrawalSchema } from '../schemas/withdrawal.schema';
import { AffiliateService } from './affiliate.service';
import { AffiliateController } from './affiliate.controller';
import { AffiliateAdminController } from './affiliate-admin.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AffiliateCommission.name, schema: AffiliateCommissionSchema },
      { name: AffiliateConfig.name,     schema: AffiliateConfigSchema },
      { name: User.name,                schema: UserSchema },
      { name: Order.name,               schema: OrderSchema },
      { name: Withdrawal.name,          schema: WithdrawalSchema },
    ]),
    JwtModule,
  ],
  controllers: [AffiliateController, AffiliateAdminController],
  providers: [AffiliateService],
  exports:   [AffiliateService],
})
export class AffiliateModule {}
