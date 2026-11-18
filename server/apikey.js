import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function aesKey(secret) {
  return createHash('sha256').update(String(secret)).digest();
}

export function sealApiKey(apiKey, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

export function openApiKey(stored, secret) {
  if (typeof stored !== 'string' || !stored.startsWith('v1.')) return '';
  const buf = Buffer.from(stored.slice(3), 'base64url');
  if (buf.length < 29) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', aesKey(secret), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
