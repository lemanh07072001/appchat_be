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
import { WebhookModule } from '../webhook/webhook.module';
import { RenewController } from './renew.controller';
import { RenewService } from './renew.service';
import { RenewScheduler } from './renew.scheduler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RenewalSelection.name, schema: RenewalSelectionSchema },
      { name: Proxy.name, schema: ProxySchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    JwtModule,
    OrdersModule,
    WebhookModule,
  ],
  controllers: [RenewController],
  providers: [RenewService, RenewScheduler],
})
export class RenewModule {}
