import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openApiKey } from '../server/apikey.js';
import { createApp } from '../server/app.js';
import { backfillStoredEntries } from '../server/catalog.js';
import { todayISO } from '../shared/nutrients.js';

process.env.SCRYPT_N = '1024';

const OLD_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE goals (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  targets_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE food_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL,
  quantity_unit TEXT NOT NULL,
  calories_kcal REAL NOT NULL,
  snapshot_json TEXT NOT NULL,
  consumed_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
`;

function cookieClient(base) {
  let cookie = '';
  return {
    async request(urlPath, { method = 'GET', body, cookie: extra } = {}) {
      const response = await fetch(`${base}${urlPath}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(extra || cookie ? { cookie: extra || cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const header of response.headers.getSetCookie?.() || []) {
        const [pair] = header.split(';');
        if (pair.startsWith('sid=')) cookie = header.includes('Max-Age=0') ? '' : pair;
      }
      const text = await response.text();
      return { status: response.status, data: text ? JSON.parse(text) : null };
    },
  };
}

function offProduct(code) {
  return {
    status: 1,
    code,
    product: {
      code,
      product_name: 'Shared Yogurt',
      brands: 'Test Brand',
      nutriments: {
        'energy-kcal_100g': 250,
        proteins_100g: 10,
        carbohydrates_100g: 20,
        fat_100g: 5,
        fiber_100g: 0,
        salt_100g: 0.1,
      },
    },
  };
}

test('migrates the previous database without splitting private rows into a second file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fitcalorie-migrate-'));
  const databasePath = path.join(directory, 'fitcalorie.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(OLD_SCHEMA);
  legacy.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    'user-a',
    'legacy@example.com',
    'not-used',
    '2026-11-01T00:00:00.000Z',
  );
  legacy.prepare('INSERT INTO goals (user_id, targets_json, updated_at) VALUES (?, ?, ?)').run(
    'user-a',
    JSON.stringify({ calories: 2000, protein: 50 }),
    '2026-11-18T00:00:00.000Z',
  );
  const snapshot = {
    basis: { type: 'per_100g', referenceAmount: 100, referenceUnit: 'g', label: 'per 100 g' },
    nutrients: {
      calories: { amount: 250, unit: 'kcal' },
      fibre: { amount: 0, unit: 'g' },
    },
    extras: [],
    serving: null,
  };
  const consumed = {
    nutrients: {
      calories: { amount: 375, unit: 'kcal' },
      fibre: { amount: 0, unit: 'g' },
    },
    extras: [],
  };
  legacy.prepare(`
    INSERT INTO food_entries (
      id, user_id, entry_date, name, quantity, quantity_unit, calories_kcal,
      snapshot_json, consumed_json, provenance_json, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'entry-1',
    'user-a',
    '2026-11-18',
    'Shared Yogurt',
    150,
    'g',
    375,
    JSON.stringify(snapshot),
    JSON.stringify(consumed),
    JSON.stringify({
      provider: 'openfoodfacts',
      reference: '3017620422003',
      confidence: 'verified',
      retrievedAt: '2026-11-18T00:00:00.000Z',
      notes: [],
    }),
    'legacy-entry-1',
    '2026-11-18T12:00:00.000Z',
    '2026-11-18T12:00:00.000Z',
  );
  legacy.close();

  const app = createApp({ databasePath, secret: 'migration-test-secret' });
  try {
    const goal = app.db.prepare('SELECT * FROM daily_goals WHERE user_id = ?').get('user-a');
    assert.equal(goal.effective_date, '1970-01-01');
    assert.equal(goal.calories, 2000);
    assert.equal(goal.protein, 50);
    const product = app.db.prepare('SELECT * FROM products WHERE barcode = ?').get('3017620422003');
    assert.equal(product.source, 'openfoodfacts');
    const reference = app.db.prepare(`
      SELECT amount FROM product_nutrients
      WHERE product_id = ? AND nutrient_key = 'calories' AND scope = 'reference'
    `).get(product.id);
    assert.equal(reference.amount, 250);
    const fibre = app.db.prepare(`
      SELECT amount FROM product_nutrients
      WHERE product_id = ? AND nutrient_key = 'fibre' AND scope = 'reference'
    `).get(product.id);
    assert.equal(fibre.amount, 0);
    const vitamin = app.db.prepare(`
      SELECT amount FROM product_nutrients
      WHERE product_id = ? AND nutrient_key = 'vitamin_c' AND scope = 'reference'
    `).get(product.id);
    assert.equal(vitamin.amount, null);
    const eaten = app.db.prepare(`
      SELECT amount FROM food_entry_nutrients WHERE entry_id = 'entry-1' AND nutrient_key = 'calories'
    `).get();
    assert.equal(eaten.amount, 375);
    const entry = app.db.prepare('SELECT product_id, consumed_at FROM food_entries WHERE id = ?').get('entry-1');
    assert.equal(entry.product_id, product.id);
    assert.equal(entry.consumed_at, '2026-11-18T12:00:00.000Z');
    const calorieColumn = app.db.prepare('PRAGMA table_info(food_entries)').all().find((column) => column.name === 'calories_kcal');
    assert.equal(calorieColumn.notnull, 0);
    assert.equal(app.db.prepare('SELECT calories_kcal FROM food_entries WHERE id = ?').get('entry-1').calories_kcal, 375);
    backfillStoredEntries(app.db);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM products').get().count, 1);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
  } finally {
    app.close();
  }
});

test('keeps private logs and goals separate inside one shared product catalog', { timeout: 30000 }, async () => {
  const day = todayISO();
  const directory = mkdtempSync(path.join(tmpdir(), 'fitcalorie-db-'));
  const fetches = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const address = String(url);
    if (address.includes('openfoodfacts.org')) {
      fetches.push(address);
      const code = address.match(/product\/(\d+)/)[1];
      return new Response(JSON.stringify(offProduct(code)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(url, options);
  };

  const app = createApp({
    databasePath: path.join(directory, 'fitcalorie.sqlite'),
    secret: 'database-test-secret',
  });
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ada = cookieClient(base);
  const ben = cookieClient(base);
  try {
    const adaUser = await ada.request('/api/auth/register', {
      method: 'POST',
      body: { email: 'ada.db@example.com', password: 'correct-horse' },
    });
    const benUser = await ben.request('/api/auth/register', {
      method: 'POST',
      body: { email: 'ben.db@example.com', password: 'correct-horse' },
    });
    assert.equal(adaUser.status, 201);
    assert.equal(benUser.status, 201);
    assert.notEqual(adaUser.data.user.id, benUser.data.user.id);

    const adaGoals = await ada.request('/api/goals', {
      method: 'PUT',
      body: { targets: { calories: 2000, protein: 80 }, userId: benUser.data.user.id },
    });
    const benGoals = await ben.request('/api/goals', {
      method: 'PUT',
      body: { targets: { calories: 1800, protein: 60 }, userId: adaUser.data.user.id },
    });
    assert.equal(adaGoals.data.goals.calories, 2000);
    assert.equal(benGoals.data.goals.calories, 1800);

    const adaFood = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        source: 'manual',
        date: day,
        name: 'Ada oats',
        quantity: 100,
        quantityUnit: 'g',
        basisType: 'per_100g',
        nutrients: { calories: { amount: 100, unit: 'kcal' } },
        idempotencyKey: 'ada-oats-0001',
        userId: benUser.data.user.id,
      },
    });
    const benFood = await ben.request('/api/entries', {
      method: 'POST',
      body: {
        source: 'manual',
        date: day,
        name: 'Ben rice',
        quantity: 100,
        quantityUnit: 'g',
        basisType: 'per_100g',
        nutrients: { calories: { amount: 130, unit: 'kcal' } },
        idempotencyKey: 'ben-rice-0001',
        userId: adaUser.data.user.id,
      },
    });
    assert.equal(adaFood.status, 201);
    assert.equal(benFood.status, 201);
    assert.deepEqual(adaFood.data.day.entries.map((entry) => entry.name), ['Ada oats']);
    assert.deepEqual(benFood.data.day.entries.map((entry) => entry.name), ['Ben rice']);
    assert.equal(adaFood.data.day.totals.calories.amount, 100);
    assert.equal(benFood.data.day.totals.calories.amount, 130);
    assert.equal(adaFood.data.day.goals.calories, 2000);
    assert.equal(benFood.data.day.goals.calories, 1800);

    const stolenEdit = await ben.request(`/api/entries/${adaFood.data.entry.id}`, {
      method: 'PATCH',
      body: { quantity: 1, quantityUnit: 'g' },
    });
    const stolenDelete = await ben.request(`/api/entries/${adaFood.data.entry.id}`, { method: 'DELETE' });
    assert.equal(stolenEdit.status, 404);
    assert.equal(stolenDelete.status, 404);
    const adaStill = await ada.request(`/api/days/${day}`);
    assert.equal(adaStill.data.entries[0].quantity, 100);
    assert.equal(adaStill.data.totals.calories.amount, 100);

    const adaLookup = await ada.request('/api/lookup/barcode', {
      method: 'POST',
      body: { barcode: '12345678' },
    });
    const benLookup = await ben.request('/api/lookup/barcode', {
      method: 'POST',
      body: { barcode: '12345678' },
    });
    assert.equal(adaLookup.status, 200);
    assert.equal(benLookup.status, 200);
    assert.equal(adaLookup.data.product.name, 'Shared Yogurt');
    assert.equal(benLookup.data.product.catalogId, adaLookup.data.product.catalogId);
    assert.equal(adaLookup.data.product.nutrients.calories.amount, 250);
    assert.equal(adaLookup.data.product.nutrients.fibre.amount, 0);
    assert.equal(adaLookup.data.product.nutrients.vitamin_c, null);
    assert.equal(fetches.length, 1);
    assert.equal(JSON.stringify(adaLookup.data.product).includes('ada.db@example.com'), false);
    assert.equal(JSON.stringify(benLookup.data.product).includes(adaUser.data.user.id), false);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM products WHERE barcode = ?').get('12345678').count, 1);

    const adaYogurt = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        reviewToken: adaLookup.data.reviewToken,
        date: day,
        quantity: 150,
        quantityUnit: 'g',
        idempotencyKey: 'ada-yogurt-01',
        userId: benUser.data.user.id,
      },
    });
    const benYogurt = await ben.request('/api/entries', {
      method: 'POST',
      body: {
        reviewToken: benLookup.data.reviewToken,
        date: day,
        quantity: 100,
        quantityUnit: 'g',
        idempotencyKey: 'ben-yogurt-01',
      },
    });
    assert.equal(adaYogurt.status, 201);
    assert.equal(adaYogurt.data.entry.calories.amount, 375);
    assert.equal(benYogurt.data.entry.calories.amount, 250);
    assert.equal(adaYogurt.data.entry.productId, benYogurt.data.entry.productId);
    assert.equal(adaYogurt.data.day.totals.calories.amount, 475);
    assert.equal(benYogurt.data.day.totals.calories.amount, 380);
    const stored = app.db.prepare(`
      SELECT amount FROM food_entry_nutrients
      WHERE entry_id = ? AND nutrient_key = 'calories'
    `).get(adaYogurt.data.entry.id);
    assert.equal(stored.amount, 375);
    const missing = app.db.prepare(`
      SELECT amount FROM food_entry_nutrients
      WHERE entry_id = ? AND nutrient_key = 'vitamin_c'
    `).get(adaYogurt.data.entry.id);
    assert.equal(missing.amount, null);
    const zero = app.db.prepare(`
      SELECT amount FROM product_nutrients
      WHERE product_id = ? AND nutrient_key = 'fibre' AND scope = 'reference'
    `).get(adaYogurt.data.entry.productId);
    assert.equal(zero.amount, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM products').get().count, 1);

    const edited = await ada.request(`/api/entries/${adaYogurt.data.entry.id}`, {
      method: 'PATCH',
      body: { quantity: 50, quantityUnit: 'g' },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.day.totals.calories.amount, 225);
    assert.equal(app.db.prepare(`
      SELECT amount FROM product_nutrients
      WHERE product_id = ? AND nutrient_key = 'calories' AND scope = 'reference'
    `).get(adaYogurt.data.entry.productId).amount, 250);
    assert.equal((await ben.request(`/api/days/${day}`)).data.totals.calories.amount, 380);

    const removed = await ada.request(`/api/entries/${adaYogurt.data.entry.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.day.totals.calories.amount, 100);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM food_entry_nutrients WHERE entry_id = ?').get(adaYogurt.data.entry.id).count, 0);
    assert.equal((await ben.request(`/api/days/${day}`)).data.totals.calories.amount, 380);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM products WHERE barcode = ?').get('12345678').count, 1);

    assert.equal((await ada.request('/api/auth/logout', { method: 'POST' })).status, 200);
    assert.equal((await ada.request(`/api/days/${day}`)).status, 401);
    const returned = await ada.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'ada.db@example.com', password: 'correct-horse' },
    });
    assert.equal(returned.status, 200);
    const persisted = await ada.request(`/api/days/${day}`);
    assert.equal(persisted.status, 200);
    assert.deepEqual(persisted.data.entries.map((entry) => entry.name), ['Ada oats']);
    assert.equal(persisted.data.totals.calories.amount, 100);
    assert.equal(persisted.data.goals.calories, 2000);

    const anonymous = await ada.request(`/api/days/${day}`, { cookie: 'sid=not-a-session' });
    assert.equal(anonymous.status, 401);
    const invalidBarcode = await ada.request('/api/lookup/barcode', {
      method: 'POST',
      body: { barcode: 'abc', userId: benUser.data.user.id },
    });
    assert.equal(invalidBarcode.status, 400);
    const injected = await ben.request(`/api/entries/${encodeURIComponent("' OR 1=1 --")}`, { method: 'DELETE' });
    assert.equal(injected.status, 404);
    assert.equal((await ada.request(`/api/days/${day}`)).data.entryCount, 1);
    assert.equal((await ben.request(`/api/days/${day}`)).data.entryCount, 2);
    const vitamin = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        source: 'manual',
        date: day,
        name: 'A-Z multi vitamins',
        quantity: 1,
        quantityUnit: 'product',
        basisType: 'portion',
        nutrients: {
          vitamin_c: { amount: 80, unit: 'mg' },
          vitamin_d: { amount: 5, unit: 'µg' },
          calcium: { amount: 240, unit: 'mg' },
        },
        idempotencyKey: 'ada-vitamins-0001',
      },
    });
    assert.equal(vitamin.status, 201);
    assert.equal(vitamin.data.entry.calories, null);
    assert.equal(vitamin.data.entry.nutrients.carbohydrates, null);
    assert.equal(vitamin.data.entry.nutrients.vitamin_c.amount, 80);
    assert.equal(vitamin.data.day.totals.calories.amount, 100);
    assert.equal(vitamin.data.day.totals.calories.partial, true);
    assert.equal(vitamin.data.day.totals.vitamin_c.amount, 80);
    assert.equal(app.db.prepare('SELECT calories_kcal FROM food_entries WHERE id = ?').get(vitamin.data.entry.id).calories_kcal, null);
    assert.equal(app.db.prepare('SELECT COUNT(DISTINCT user_id) AS count FROM food_entries').get().count, 2);
    assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'users'`).get().count, 1);
  } finally {
    global.fetch = originalFetch;
    server.close();
    app.close();
  }
});

test('stores an account API key and uses it when a page has no nutrition table', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const directory = mkdtempSync(path.join(tmpdir(), 'fitcalorie-key-'));
  const secret = 'api-key-test-secret';
  const apiKey = 'sk-test-user-key-1234567890';
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const address = String(url);
    if (address.startsWith('https://api.openai.com/')) {
      calls.push(options?.headers?.authorization || '');
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              productName: 'Plain oats',
              basis: null,
              nutrients: { calories: { amount: 120, unit: 'kcal' } },
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (address === 'http://1.1.1.1/plain-oats') {
      return new Response('<html><title>Plain oats</title><body><p>Energy 120 kcal</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return originalFetch(url, options);
  };

  const app = createApp({
    databasePath: path.join(directory, 'fitcalorie.sqlite'),
    secret,
  });
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ada = cookieClient(base);
  const ben = cookieClient(base);
  const guest = cookieClient(base);
  try {
    assert.equal((await guest.request('/api/settings/ai')).status, 401);
    assert.equal((await ada.request('/api/auth/register', {
      method: 'POST',
      body: { email: 'ada.key@example.com', password: 'correct-horse' },
    })).status, 201);
    assert.equal((await ben.request('/api/auth/register', {
      method: 'POST',
      body: { email: 'ben.key@example.com', password: 'correct-horse' },
    })).status, 201);

    assert.deepEqual((await ada.request('/api/settings/ai')).data, { configured: false, source: null });
    assert.equal((await ada.request('/api/settings/ai', { method: 'PUT', body: { apiKey: 'short' } })).status, 400);
    const page = 'http://1.1.1.1/plain-oats';
    const blocked = await ada.request('/api/lookup/url', { method: 'POST', body: { url: page } });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.data.code, 'NUTRITION_UNAVAILABLE');
    assert.equal(calls.length, 0);

    const saved = await ada.request('/api/settings/ai', { method: 'PUT', body: { apiKey } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data, { configured: true, source: 'account' });
    assert.equal(JSON.stringify(saved.data).includes(apiKey), false);
    const stored = app.db.prepare('SELECT openai_api_key FROM users WHERE email = ?').get('ada.key@example.com');
    assert.equal(String(stored.openai_api_key).includes(apiKey), false);
    assert.equal(openApiKey(stored.openai_api_key, secret), apiKey);
    assert.deepEqual((await ben.request('/api/settings/ai')).data, { configured: false, source: null });

    const extracted = await ada.request('/api/lookup/url', { method: 'POST', body: { url: page } });
    assert.equal(extracted.status, 200, JSON.stringify(extracted.data));
    assert.equal(extracted.data.product.provenance.provider, 'ai');
    assert.equal(extracted.data.product.nutrients.calories.amount, 120);
    assert.deepEqual(calls, [`Bearer ${apiKey}`]);
    assert.equal(JSON.stringify(extracted.data).includes(apiKey), false);

    const cleared = await ada.request('/api/settings/ai', { method: 'DELETE' });
    assert.deepEqual(cleared.data, { configured: false, source: null });
    assert.equal(app.db.prepare('SELECT openai_api_key FROM users WHERE email = ?').get('ada.key@example.com').openai_api_key, null);
  } finally {
    if (previousKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    global.fetch = originalFetch;
    server.close();
    app.close();
  }
});
