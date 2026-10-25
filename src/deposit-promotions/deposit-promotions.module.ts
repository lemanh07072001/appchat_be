import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { DepositIntent, DepositIntentSchema, DepositPromotionCatalog, DepositPromotionCatalogSchema } from './deposit-promotions.schema';
import { Transaction, TransactionSchema } from '../schemas/transactions.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { WalletTransaction, WalletTransactionSchema } from '../schemas/wallet-transaction.schema';
import { DepositPromotionsService } from './deposit-promotions.service';
import { DepositCreditService } from './deposit-credit.service';
import { AdminDepositPromotionsController, DepositPromotionsController } from './deposit-promotions.controller';

@Module({
  imports: [JwtModule, MongooseModule.forFeature([
    { name: DepositIntent.name, schema: DepositIntentSchema },
    { name: DepositPromotionCatalog.name, schema: DepositPromotionCatalogSchema },
    { name: Transaction.name, schema: TransactionSchema },
    { name: User.name, schema: UserSchema },
    { name: WalletTransaction.name, schema: WalletTransactionSchema },
  ])],
  controllers: [DepositPromotionsController, AdminDepositPromotionsController],
  providers: [DepositPromotionsService, DepositCreditService],
  exports: [DepositPromotionsService, DepositCreditService],
})
export class DepositPromotionsModule {}
