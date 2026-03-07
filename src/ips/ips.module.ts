import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Ip, IpSchema } from '../schemas/ips.schema';
import { IpsService } from './ips.service';
import { IpsController } from './ips.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Ip.name, schema: IpSchema }]),
    JwtModule,
  ],
  controllers: [IpsController],
  providers: [IpsService],
  exports: [IpsService],
})
export class IpsModule {}
