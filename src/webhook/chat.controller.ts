import { Controller, Get, Param, Post, Req, Res, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Response } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { ChatMessage, ChatMessageDocument } from '../schemas/chat-message.schema';
import { User, UserDocument } from '../schemas/users.schema';

const UPLOAD_DIR = join(process.cwd(), 'uploads', 'chat');
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

@Controller('api')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(
    @InjectModel(ChatMessage.name) private chatModel: Model<ChatMessageDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  @Get('chat/history')
  getHistory(@Req() req: any) {
    return this.chatModel
      .find({ room_id: req.user.sub })
      .sort({ createdAt: 1 })
      .limit(100)
      .lean();
  }

  @UseGuards(AdminGuard)
  @Get('admin/chat/rooms')
  async getRooms() {
    const rooms = await this.chatModel.aggregate([
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$room_id',
          lastMessage: { $first: '$$ROOT' },
          unread: {
            $sum: {
              $cond: [{ $and: [{ $eq: ['$sender_type', 'user'] }, { $eq: ['$read', false] }] }, 1, 0],
            },
          },
        },
      },
      { $sort: { 'lastMessage.createdAt': -1 } },
    ]);
    // Lookup user info
    const userIds = rooms.map((r) => r._id);
    const users = await this.userModel.find({ _id: { $in: userIds } }).select('email name').lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));
    return rooms.map((r) => ({
      ...r,
      user: userMap.get(r._id) || null,
    }));
  }

  @UseGuards(AdminGuard)
  @Get('admin/chat/history/:userId')
  getRoomHistory(@Param('userId') userId: string) {
    return this.chatModel
      .find({ room_id: userId })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();
  }

  @UseGuards(AdminGuard)
  @Post('admin/chat/read/:userId')
  async markRead(@Param('userId') userId: string) {
    await this.chatModel.updateMany(
      { room_id: userId, sender_type: 'user', read: false },
      { read: true },
    );
    return { ok: true };
  }

  @Post('chat/upload')
  @UseInterceptors(FileInterceptor('image', {
    storage: diskStorage({
      destination: UPLOAD_DIR,
      filename: (_req, file, cb) => {
        const name = Date.now() + '-' + Math.round(Math.random() * 1e9) + extname(file.originalname);
        cb(null, name);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!file.mimetype.match(/^image\//)) {
        cb(new Error('Only images allowed'), false);
        return;
      }
      cb(null, true);
    },
  }))
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    return { url: `/api/chat/uploads/${file.filename}` };
  }

  @Get('chat/uploads/:filename')
  getUpload(@Param('filename') filename: string, @Res() res: Response) {
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = join(UPLOAD_DIR, safe);
    if (!existsSync(filePath)) {
      res.status(404).json({ message: 'Not found' });
      return;
    }
    res.sendFile(filePath);
  }
}
