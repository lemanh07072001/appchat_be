import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import {
  DailyUserStat,
  DailyUserStatSchema,
} from '../schemas/daily-user-stat.schema';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { StatsScheduler } from './stats.scheduler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DailyUserStat.name, schema: DailyUserStatSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    JwtModule,
  ],
  controllers: [StatsController],
  providers: [StatsService, StatsScheduler],
  exports: [StatsService],
})
export class StatsModule {}
