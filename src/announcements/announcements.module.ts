import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Announcement, AnnouncementSchema } from '../schemas/announcements.schema';
import { AnnouncementsController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';
import { TranslationsModule } from '../translations/translations.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Announcement.name, schema: AnnouncementSchema }]),
    JwtModule,
    TranslationsModule,
  ],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}
