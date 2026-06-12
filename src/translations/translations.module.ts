import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Translation, TranslationSchema } from '../schemas/translations.schema';
import { TranslationsService } from './translations.service';
import { TranslationsController } from './translations.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Translation.name, schema: TranslationSchema }]),
    JwtModule,
  ],
  controllers: [TranslationsController],
  providers: [TranslationsService],
  exports: [TranslationsService],
})
export class TranslationsModule {}
