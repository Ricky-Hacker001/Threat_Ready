import { createCipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@threatready/shared';
import { logger } from '../../platform/logging/logger.js';

/** apps/api/assets/interviewer.glb, from both src/ (tsx) and dist/ (build). */
const MODEL_PATH = fileURLToPath(new URL('../../../assets/interviewer.glb', import.meta.url));

export interface EncryptedAsset {
  body: Buffer;
  key: string;
  iv: string;
}

/**
 * The 3D interviewer model. Its licence (Renderpeople Extended Use, §4.3b) requires that the model
 * is not made easily accessible for download or extraction, so it is never a public static file:
 * it is served only to signed-in users, encrypted with a fresh AES-256-GCM key per response and
 * marked not cacheable. This raises the bar for casual copying; it is not DRM.
 */
@Injectable()
export class AssetsService {
  private model?: Promise<Buffer>;

  private load(): Promise<Buffer> {
    this.model ??= readFile(MODEL_PATH).catch((err: unknown) => {
      this.model = undefined;
      logger.warn({ path: MODEL_PATH, err: (err as Error).message }, 'interviewer model not available');
      throw new DomainError('ASSET_NOT_AVAILABLE');
    });
    return this.model;
  }

  async interviewerModel(): Promise<EncryptedAsset> {
    const plain = await this.load();
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    // WebCrypto expects the GCM tag appended to the ciphertext
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return { body, key: key.toString('base64'), iv: iv.toString('base64') };
  }
}
