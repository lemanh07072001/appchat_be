import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { WalletTransaction, WalletTransactionSchema } from '../schemas/wallet-transaction.schema';
import { WalletTransactionService } from './wallet-transaction.service';
import { WalletController } from './wallet.controller';

@Module({
  imports: [
    JwtModule,
    MongooseModule.forFeature([
      { name: WalletTransaction.name, schema: WalletTransactionSchema },
    ]),
  ],
  controllers: [WalletController],
  providers: [WalletTransactionService],
  exports: [WalletTransactionService],
})
export class WalletModule {}
