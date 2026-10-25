import { createCipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, secondsUntilUtcMidnight } from '@threatready/shared';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { Principal } from '../../platform/authz/principal.js';
import { logger } from '../../platform/logging/logger.js';
import { CACHE_PORT, type CachePort } from '../../platform/ports/cache.port.js';

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
 * marked not cacheable. This raises the bar for casual copying; it is not DRM. Each account may
 * fetch it INTERVIEW_MODEL_DOWNLOADS_PER_DAY times per UTC day (enough for several interviews and
 * reloads), so one free account cannot be used to pull copies in bulk.
 */
@Injectable()
export class AssetsService {
  private model?: Promise<Buffer>;

  constructor(
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private load(): Promise<Buffer> {
    this.model ??= readFile(MODEL_PATH).catch((err: unknown) => {
      this.model = undefined;
      logger.warn({ path: MODEL_PATH, err: (err as Error).message }, 'interviewer model not available');
      throw new DomainError('ASSET_NOT_AVAILABLE');
    });
    return this.model;
  }

  async interviewerModel(p: Pick<Principal, 'userId'>): Promise<EncryptedAsset> {
    const quota = this.cfg.INTERVIEW_MODEL_DOWNLOADS_PER_DAY;
    if (quota > 0) {
      const day = new Date().toISOString().slice(0, 10);
      const n = await this.cache.incr(`asset:model:${p.userId}:${day}`, secondsUntilUtcMidnight() + 60);
      if (n > quota) {
        if (n === quota + 1) logger.warn({ user_id: p.userId, quota }, 'interviewer model download quota reached');
        const wait = secondsUntilUtcMidnight();
        throw new DomainError('RATE_LIMITED', { message: 'The 3D interviewer is unavailable until tomorrow on this account; the interview works without it', retryAfterSec: wait, retryable: false, details: { scope: 'interviewer_model', retryAfterSec: wait } });
      }
    }
    const plain = await this.load();
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    // WebCrypto expects the GCM tag appended to the ciphertext
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return { body, key: key.toString('base64'), iv: iv.toString('base64') };
  }
}
