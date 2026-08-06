import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Partner, PartnerSchema } from '../schemas/partners.schema';
import { PartnersService } from './partners.service';
import { PartnersController } from './partners.controller';
import { ProxyProvidersModule } from '../proxy-providers/proxy-providers.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Partner.name, schema: PartnerSchema }]),
    JwtModule,
    // Để màn hình nhà cung cấp đọc được registry adapter.
    ProxyProvidersModule,
  ],
  controllers: [PartnersController],
  providers: [PartnersService],
  exports: [PartnersService],
})
export class PartnersModule {}
