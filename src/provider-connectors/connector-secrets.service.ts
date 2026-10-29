import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

@Injectable()
export class ConnectorSecrets {
  constructor(private readonly config: ConfigService) {}
  private key(): Buffer {
    const encoded = this.config.get<string>('CONNECTOR_ENCRYPTION_KEY', '');
    if (!/^[a-fA-F0-9]{64}$/.test(encoded)) {
      throw new ServiceUnavailableException('CONNECTOR_ENCRYPTION_KEY must be a dedicated 32-byte hex key');
    }
    return Buffer.from(encoded, 'hex');
  }
  encrypt(secret: string, accountId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(`connector-account:${accountId}`));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
  }
  decrypt(value: string, accountId: string): string {
    const key = this.key();
    try {
      const [version, iv, tag, data, extra] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !data || extra !== undefined) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(`connector-account:${accountId}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('Cannot decrypt connector credential');
    }
  }
}
