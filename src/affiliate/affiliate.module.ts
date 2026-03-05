import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AffiliateCommission, AffiliateCommissionSchema } from '../schemas/affiliate-commission.schema';
import { AffiliateConfig, AffiliateConfigSchema } from '../schemas/affiliate-config.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { AffiliateService } from './affiliate.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AffiliateCommission.name, schema: AffiliateCommissionSchema },
      { name: AffiliateConfig.name,     schema: AffiliateConfigSchema },
      { name: User.name,                schema: UserSchema },
    ]),
  ],
  providers: [AffiliateService],
  exports:   [AffiliateService],
})
export class AffiliateModule {}
