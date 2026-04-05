import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Service, ServiceSchema } from '../schemas/services.schema';
import { User, UserSchema } from '../schemas/users.schema';
import { ServicesService } from './services.service';
import { ServicesController } from './services.controller';
import { ApiTokenGuard } from '../guards/api-token.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Service.name, schema: ServiceSchema },
      { name: User.name, schema: UserSchema },
    ]),
    JwtModule,
  ],
  controllers: [ServicesController],
  providers: [ServicesService, ApiTokenGuard],
  exports: [ServicesService],
})
export class ServicesModule {}
