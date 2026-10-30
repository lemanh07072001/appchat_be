import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Partner, PartnerSchema } from '../schemas/partners.schema';
import { Country, CountrySchema } from '../schemas/countries.schema';
import { ProxyProvidersModule } from '../proxy-providers/proxy-providers.module';
import { CountryPolicyService } from './country-policy.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Partner.name, schema: PartnerSchema }, { name: Country.name, schema: CountrySchema }]), ProxyProvidersModule],
  providers: [CountryPolicyService], exports: [CountryPolicyService],
})
export class CountryPolicyModule {}
