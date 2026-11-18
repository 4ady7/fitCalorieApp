import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { HttpError } from './errors.js';
import {
  createSession,
  destroySession,
  hashPassword,
  publicUser,
  readSession,
  requireUser,
  verifyPassword,
} from './auth.js';
import { loadSecret, signReview } from './sign.js';
import { aiIsConfigured } from './ai.js';
import { lookupBarcode, lookupProductUrl } from './lookup.js';
import { addEntry, dayPayload, deleteEntry, saveGoals, updateEntry } from './entries.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cookieToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'sid') return decodeURIComponent(rest.join('='));
  }
  return '';
}

function writeSessionCookie(res, token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function rateLimit(map, key, limit, windowMs) {
  const now = Date.now();
  const fresh = (map.get(key) || []).filter((stamp) => now - stamp < windowMs);
  if (fresh.length >= limit) return false;
  fresh.push(now);
  map.set(key, fresh);
  return true;
}

function assertOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers.host;
  const allowed = new Set([
    `http://${host}`,
    `https://${host}`,
    process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
  if (!allowed.has(origin)) throw new HttpError(403, 'This request was rejected.', 'BAD_ORIGIN');
}

function emailOf(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw new HttpError(400, 'Enter a valid email address.', 'BAD_EMAIL');
  }
  return email;
}

function passwordOf(value, creating) {
  const password = String(value || '');
  if (creating && password.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.', 'BAD_PASSWORD');
  if (password.length > 200) throw new HttpError(400, 'That password is too long.', 'BAD_PASSWORD');
  if (!password) throw new HttpError(400, 'Enter your password.', 'BAD_PASSWORD');
  return password;
}

export function createApp(options = {}) {
  const databasePath = options.databasePath || process.env.DATABASE_PATH || path.join(root, 'data', 'fitcalorie.sqlite');
  const db = options.db || openDatabase(databasePath);
  const secret = options.secret || loadSecret(path.dirname(databasePath));
  const lookups = new Map();
  const logins = new Map();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    req.user = readSession(db, cookieToken(req));
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, aiConfigured: aiIsConfigured() });
  });

  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    assertOrigin(req);
    const email = emailOf(req.body?.email);
    const password = passwordOf(req.body?.password, true);
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) throw new HttpError(409, 'An account with that email already exists.', 'EMAIL_TAKEN');
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      email,
      hashPassword(password),
      new Date().toISOString(),
    );
    const session = createSession(db, id);
    writeSessionCookie(res, session.token, session.maxAge);
    res.status(201).json({ user: { id, email } });
  }));

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    assertOrigin(req);
    const email = emailOf(req.body?.email);
    const password = passwordOf(req.body?.password, false);
    const ip = req.socket.remoteAddress || 'local';
    if (!rateLimit(logins, `${ip}|${email}`, 20, 15 * 60 * 1000)) {
      throw new HttpError(429, 'Too many sign-in attempts. Wait a moment and try again.', 'RATE_LIMITED');
    }
    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'That email and password do not match.', 'BAD_LOGIN');
    }
    const session = createSession(db, user.id);
    writeSessionCookie(res, session.token, session.maxAge);
    res.json({ user: { id: user.id, email: user.email } });
  }));

  app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    assertOrigin(req);
    destroySession(db, cookieToken(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Log in to continue.', code: 'UNAUTHENTICATED' });
    res.json({ user: publicUser(req.user) });
  });

  app.get('/api/days/:date', asyncRoute(async (req, res) => {
    const user = requireUser(req);
    res.json(dayPayload(db, user.id, req.params.date));
  }));

  app.put('/api/goals', asyncRoute(async (req, res) => {
    assertOrigin(req);
    const user = requireUser(req);
    res.json({ goals: saveGoals(db, user.id, req.body?.targets || req.body) });
  }));

  app.post('/api/entries', asyncRoute(async (req, res) => {
    assertOrigin(req);
    const user = requireUser(req);
    const result = addEntry(db, user.id, secret, req.body || {});
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  app.patch('/api/entries/:id', asyncRoute(async (req, res) => {
    assertOrigin(req);
    const user = requireUser(req);
    res.json({ day: updateEntry(db, user.id, req.params.id, req.body || {}) });
  }));

  app.delete('/api/entries/:id', asyncRoute(async (req, res) => {
    assertOrigin(req);
    const user = requireUser(req);
    res.json({ day: deleteEntry(db, user.id, req.params.id) });
  }));

  app.post('/api/lookup/barcode', asyncRoute(async (req, res) => {
    assertOrigin(req);
    const user = requireUser(req);
    if (!rateLimit(lookups, user.id, 40, 10 * 60 * 1000)) {
      throw new HttpError(429, 'Too many product lookups. Wait a moment and try again.', 'RATE_LIMITED');
    }
    const product = await lookupBarcode(req.body?.barcode);
    res.json({ product, reviewToken: signReview(user.id, product, secret) });
  }));

  app.post('/api/lookup/url', asyncRoute(async (req, res) => {
    assertOrigin(req);
    const user = requireUser(req);
    if (!rateLimit(lookups, user.id, 40, 10 * 60 * 1000)) {
      throw new HttpError(429, 'Too many product lookups. Wait a moment and try again.', 'RATE_LIMITED');
    }
    const product = await lookupProductUrl(req.body?.url);
    res.json({ product, reviewToken: signReview(user.id, product, secret) });
  }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'That API route does not exist.', code: 'NOT_FOUND' });
  });

  const dist = path.join(root, 'dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'The request body was not valid JSON.', code: 'BAD_JSON' });
    }
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({
      error: status >= 500 ? 'Something went wrong on the server.' : error.message,
      code: error.code || (status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST'),
      ...(error.productName ? { productName: error.productName } : {}),
    });
  });

  return {
    app,
    db,
    secret,
    close() {
      db.close();
    },
  };
}
