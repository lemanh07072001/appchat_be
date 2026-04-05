import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { BlogPost, BlogPostSchema } from '../schemas/blog-post.schema';
import { BlogService } from './blog.service';
import { BlogController } from './blog.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BlogPost.name, schema: BlogPostSchema },
    ]),
    JwtModule,
  ],
  controllers: [BlogController],
  providers: [BlogService],
})
export class BlogModule {}
