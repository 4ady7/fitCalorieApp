import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';

const REVIEW_MS = 1000 * 60 * 30;

export function loadSecret(directory) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'hmac.secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}

export function signReview(userId, product, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    exp: now + REVIEW_MS,
    userId,
    product,
  }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readReview(token, secret, userId) {
  if (typeof token !== 'string' || token.length > 200_000 || !token.includes('.')) {
    throw new HttpError(400, 'The product preview is invalid. Look the product up again.', 'BAD_REVIEW');
  }
  const splitAt = token.lastIndexOf('.');
  const payload = token.slice(0, splitAt);
  const signature = token.slice(splitAt + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new HttpError(400, 'The product preview is invalid. Look the product up again.', 'BAD_REVIEW');
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'The product preview is invalid. Look the product up again.', 'BAD_REVIEW');
  }
  if (!data?.exp || data.exp < Date.now()) {
    throw new HttpError(400, 'This product preview expired. Look the product up again.', 'REVIEW_EXPIRED');
  }
  if (data.userId !== userId) {
    throw new HttpError(400, 'The product preview is invalid. Look the product up again.', 'BAD_REVIEW');
  }
  return data.product;
}
