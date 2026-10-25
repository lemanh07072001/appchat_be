import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { User, UserSchema } from '../schemas/users.schema';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { Service, ServiceSchema } from '../schemas/services.schema';
import { VouchersService } from './vouchers.service';
import { VouchersController } from './vouchers.controller';
import { Proxy, ProxySchema } from '../schemas/proxies.schema';
import { AffiliateModule } from '../affiliate/affiliate.module';

@Module({
  imports: [JwtModule, AffiliateModule, MongooseModule.forFeature([
    { name: User.name, schema: UserSchema }, { name: Order.name, schema: OrderSchema }, { name: Service.name, schema: ServiceSchema },
    { name: Proxy.name, schema: ProxySchema },
  ])],
  providers: [VouchersService], controllers: [VouchersController], exports: [VouchersService],
})
export class VouchersModule {}
