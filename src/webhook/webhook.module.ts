import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Transaction, TransactionSchema } from '../schemas/transactions.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: User.name,        schema: UserSchema },
    ]),
  ],
  controllers: [WebhookController],
  providers:   [WebhookService],
})
export class WebhookModule {}
