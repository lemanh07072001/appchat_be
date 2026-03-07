import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Transaction, TransactionSchema } from '../schemas/transactions.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { NotificationGateway } from './notification.gateway';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: User.name,        schema: UserSchema },
    ]),
    JwtModule,
  ],
  controllers: [WebhookController],
  providers:   [WebhookService, NotificationGateway],
  exports:     [NotificationGateway],
})
export class WebhookModule {}
