import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { Service, ServiceSchema } from '../schemas/services.schema';
import { Country, CountrySchema } from '../schemas/countries.schema';
import { Partner, PartnerSchema } from '../schemas/partners.schema';
import { Proxy, ProxySchema } from '../schemas/proxies.schema';
import { OrderLog, OrderLogSchema } from '../schemas/order-log.schema';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { ApiTokenGuard } from '../guards/api-token.guard';
import { OrdersScheduler } from './orders.scheduler';
import { OrdersProcessingScheduler } from './orders-processing.scheduler';
import { OrdersExpirationScheduler } from './orders-expiration.scheduler';
// import { OrdersRecoveryScheduler } from './orders-recovery.scheduler'; // tạm tắt — bật lại khi cần fallback cho PENDING_REFUND
import { OrderLogService } from './order-log.service';
import { ProxyRotateService } from './proxy-rotate.service';
import { ProxyCheckService } from './proxy-check.service';
import { ProxyProvidersModule } from '../proxy-providers/proxy-providers.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { WalletModule } from '../wallet/wallet.module';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Country.name, schema: CountrySchema },
      { name: Partner.name, schema: PartnerSchema },
      { name: Proxy.name, schema: ProxySchema },
      { name: OrderLog.name, schema: OrderLogSchema },
    ]),
    JwtModule,
    ProxyProvidersModule,
    AffiliateModule,
    WalletModule,
    WebhookModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersScheduler, OrdersProcessingScheduler, OrdersExpirationScheduler, /* OrdersRecoveryScheduler, */ OrderLogService, ProxyRotateService, ProxyCheckService, ApiTokenGuard],
  exports: [OrdersService],
})
export class OrdersModule {}
