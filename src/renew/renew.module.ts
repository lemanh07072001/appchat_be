import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import {
  RenewalSelection,
  RenewalSelectionSchema,
} from './schemas/renewal-selection.schema';
import { Proxy, ProxySchema } from '../schemas/proxies.schema';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { OrdersModule } from '../orders/orders.module';
import { RenewController } from './renew.controller';
import { RenewService } from './renew.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RenewalSelection.name, schema: RenewalSelectionSchema },
      { name: Proxy.name, schema: ProxySchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    JwtModule,
    OrdersModule,
  ],
  controllers: [RenewController],
  providers: [RenewService],
})
export class RenewModule {}
