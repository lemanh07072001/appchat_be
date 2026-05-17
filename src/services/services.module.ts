import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Service, ServiceSchema } from '../schemas/services.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { Partner, PartnerSchema } from '../schemas/partners.schema';
import { Country, CountrySchema } from '../schemas/countries.schema';
import { ServicesService } from './services.service';
import { ServicesController } from './services.controller';
import { ApiTokenGuard } from '../guards/api-token.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Service.name, schema: ServiceSchema },
      { name: User.name, schema: UserSchema },
      { name: Partner.name, schema: PartnerSchema },
      { name: Country.name, schema: CountrySchema },
    ]),
    JwtModule,
  ],
  controllers: [ServicesController],
  providers: [ServicesService, ApiTokenGuard],
  exports: [ServicesService],
})
export class ServicesModule {}
