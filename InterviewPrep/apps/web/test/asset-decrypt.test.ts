import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptAsset } from '../src/features/interview-prep/avatar/loadModel';

describe('interviewer model decryption', () => {
  it('decrypts the AES-GCM asset format the API sends', async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const plain = Buffer.from('glTF fake model bytes');
    const c = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const out = await decryptAsset(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), key.toString('base64'), iv.toString('base64'));
    expect(Buffer.from(out).toString()).toBe('glTF fake model bytes');
  });
  it('rejects a tampered payload', async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(Buffer.from('x')), c.final(), c.getAuthTag()]);
    body[0]! ^= 1;
    await expect(decryptAsset(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), key.toString('base64'), iv.toString('base64'))).rejects.toThrow();
  });
});
