import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { CountriesModule } from './countries/countries.module';
import { PartnersModule } from './partners/partners.module';
import { ServicesModule } from './services/services.module';
import { OrdersModule } from './orders/orders.module';
import { RedisModule } from './redis/redis.module';
import { AffiliateModule } from './affiliate/affiliate.module';
import { WebhookModule } from './webhook/webhook.module';
import { IpsModule } from './ips/ips.module';
import { UploadModule } from './upload/upload.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { BlogModule } from './blog/blog.module';

@Module({
  imports: [
    // Cho phép ConfigModule để đọc file .env
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // Kết nối MongoDB
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGO_URI'),
        maxPoolSize: 30,
        minPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 30000,
      }),
    }),

    // Cron jobs
    ScheduleModule.forRoot(),

    // Redis (global)
    RedisModule,

    UsersModule,

    AuthModule,

    CountriesModule,

    PartnersModule,

    ServicesModule,

    OrdersModule,

    AffiliateModule,

    WebhookModule,

    IpsModule,

    UploadModule,

    AnnouncementsModule,

    BlogModule,

    // Serve static files (uploads)
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
