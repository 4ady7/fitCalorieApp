import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';

const SESSION_MS = 1000 * 60 * 60 * 24 * 30;

export function hashPassword(password) {
  const n = Number(process.env.SCRYPT_N || 16384);
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32, { N: n }).toString('hex');
  return `scrypt$${n}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, nRaw, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const n = Number(nRaw);
  if (!Number.isInteger(n) || n < 1024) return false;
  const next = scryptSync(password, salt, 32, { N: n });
  const prev = Buffer.from(hash, 'hex');
  return prev.length === next.length && timingSafeEqual(prev, next);
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_MS).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expires);
  return { token, maxAge: Math.floor(SESSION_MS / 1000) };
}

export function readSession(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT sessions.user_id AS id, sessions.expires_at, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(hashToken(token));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return { id: row.id, email: row.email };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function requireUser(req) {
  if (!req.user) throw new HttpError(401, 'Log in to continue.', 'UNAUTHENTICATED');
  return req.user;
}

export function publicUser(user) {
  return { id: user.id, email: user.email };
}
