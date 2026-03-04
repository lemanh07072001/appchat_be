import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { Service, ServiceSchema } from '../schemas/services.schema';
import { Country, CountrySchema } from '../schemas/countries.schema';
import { Partner, PartnerSchema } from '../schemas/partners.schema';
import { Proxy, ProxySchema } from '../schemas/proxies.schema';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrdersScheduler } from './orders.scheduler';
import { OrdersProcessingScheduler } from './orders-processing.scheduler';
import { OrdersExpirationScheduler } from './orders-expiration.scheduler';
import { ProxyProvidersModule } from '../proxy-providers/proxy-providers.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Country.name, schema: CountrySchema },
      { name: Partner.name, schema: PartnerSchema },
      { name: Proxy.name, schema: ProxySchema },
    ]),
    JwtModule,
    ProxyProvidersModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersScheduler, OrdersProcessingScheduler, OrdersExpirationScheduler],
  exports: [OrdersService],
})
export class OrdersModule {}
