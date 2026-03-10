import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import sharp from 'sharp';
import * as crypto from 'crypto';

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  async uploadImage(file: Express.Multer.File, folder = 'general') {
    // Validate
    if (!file) throw new BadRequestException('Chưa chọn file');
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      throw new BadRequestException('File không hợp lệ. Chỉ chấp nhận ảnh jpg, png, gif, webp dưới 5MB');
    }
    if (file.size > MAX_SIZE) {
      throw new BadRequestException('File không hợp lệ. Chỉ chấp nhận ảnh jpg, png, gif, webp dưới 5MB');
    }

    // Tạo thư mục nếu chưa có
    const folderPath = path.join(UPLOAD_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Generate tên file random
    const fileName = crypto.randomBytes(16).toString('hex') + '.webp';
    const filePath = path.join(folderPath, fileName);
    const key = `${folder}/${fileName}`;

    // Convert sang webp + compress
    let sharpInstance = sharp(file.buffer);

    // Resize nếu ảnh quá lớn (max 1920px width)
    const metadata = await sharpInstance.metadata();
    if (metadata.width && metadata.width > 1920) {
      sharpInstance = sharpInstance.resize(1920);
    }

    const output = await sharpInstance
      .webp({ quality: 80 })
      .toBuffer();

    fs.writeFileSync(filePath, output);

    const baseUrl = process.env.UPLOAD_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

    this.logger.log(`Upload: ${file.originalname} → ${key} (${(output.length / 1024).toFixed(1)}KB)`);

    return {
      success: true,
      data: {
        url: `${baseUrl}/uploads/${key}`,
        key,
        size: output.length,
        mimetype: 'image/webp',
        originalName: file.originalname,
      },
    };
  }

  async deleteImage(key: string) {
    if (!key) throw new BadRequestException('Cần truyền key');

    // Chống path traversal
    const sanitized = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(UPLOAD_DIR, sanitized);

    if (!filePath.startsWith(UPLOAD_DIR)) {
      throw new BadRequestException('Key không hợp lệ');
    }

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this.logger.log(`Delete: ${key}`);
    }

    return { success: true, message: 'Đã xoá ảnh thành công' };
  }
}
