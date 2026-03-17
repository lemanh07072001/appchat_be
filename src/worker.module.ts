import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from './schemas/orders.schema';
import { Partner, PartnerSchema } from './schemas/partners.schema';
import { Service, ServiceSchema } from './schemas/services.schema';
import { Proxy, ProxySchema } from './schemas/proxies.schema';
import { OrderLog, OrderLogSchema } from './schemas/order-log.schema';
import { RedisModule } from './redis/redis.module';
import { ProxyProvidersModule } from './proxy-providers/proxy-providers.module';
import { AffiliateModule } from './affiliate/affiliate.module';
import { OrdersWorkerService } from './orders/orders.worker.service';
import { OrdersProcessingWorkerService } from './orders/orders-processing.worker.service';
import { OrderLogService } from './orders/order-log.service';

/**
 * Module tối giản cho worker process — không có HTTP server.
 * Bootstrap bằng src/worker.ts, chạy độc lập với app chính.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGO_URI'),
        maxPoolSize: 30,
        minPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 30000,
      }),
    }),

    MongooseModule.forFeature([
      { name: Order.name,   schema: OrderSchema },
      { name: Partner.name, schema: PartnerSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Proxy.name,   schema: ProxySchema },
      { name: OrderLog.name, schema: OrderLogSchema },
    ]),

    RedisModule,
    ProxyProvidersModule,
    AffiliateModule,
  ],
  providers: [OrdersWorkerService, OrdersProcessingWorkerService, OrderLogService],
})
export class WorkerModule {}
