import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

// Snapshot file format (all binary):
//   "TSS1" | salt (16) | iv (12) | auth tag (16) | AES-256-GCM ciphertext of gzip(JSON)
// The key is derived from DATA_ENCRYPTION_KEY with scrypt and a random salt per file, so the
// GitHub repository only ever holds ciphertext. Tampering is detected by the GCM auth tag.

const MAGIC = Buffer.from('TSS1');

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function sealSnapshot(json: string, secret: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(json, 'utf8'))), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export class SnapshotDecryptError extends Error {}

export function openSnapshot(data: Buffer, secret: string): string {
  if (data.length < 48 || !data.subarray(0, 4).equals(MAGIC)) {
    throw new SnapshotDecryptError('Not a TaskSync snapshot');
  }
  const salt = data.subarray(4, 20);
  const iv = data.subarray(20, 32);
  const tag = data.subarray(32, 48);
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data.subarray(48)), decipher.final()]);
    return gunzipSync(plain).toString('utf8');
  } catch {
    throw new SnapshotDecryptError('Snapshot could not be decrypted: wrong DATA_ENCRYPTION_KEY or a damaged file');
  }
}
