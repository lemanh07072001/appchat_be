import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Transaction, TransactionSchema } from '../schemas/transactions.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { WebhookLog, WebhookLogSchema } from '../schemas/webhook-log.schema';
import { ChatMessage, ChatMessageSchema } from '../schemas/chat-message.schema';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { ChatController } from './chat.controller';
import { NotificationGateway } from './notification.gateway';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name,  schema: TransactionSchema },
      { name: User.name,         schema: UserSchema },
      { name: Order.name,        schema: OrderSchema },
      { name: WebhookLog.name,   schema: WebhookLogSchema },
      { name: ChatMessage.name,  schema: ChatMessageSchema },
    ]),
    JwtModule,
  ],
  controllers: [WebhookController, ChatController],
  providers:   [WebhookService, NotificationGateway],
  exports:     [NotificationGateway],
})
export class WebhookModule {}
