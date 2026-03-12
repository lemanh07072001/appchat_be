import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WalletTransaction, WalletTransactionSchema } from '../schemas/wallet-transaction.schema';
import { WalletTransactionService } from './wallet-transaction.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WalletTransaction.name, schema: WalletTransactionSchema },
    ]),
  ],
  providers: [WalletTransactionService],
  exports: [WalletTransactionService],
})
export class WalletModule {}
