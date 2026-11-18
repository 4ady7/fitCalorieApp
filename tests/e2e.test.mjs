import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';

process.env.SCRYPT_N = '1024';

function cookieClient(base) {
  let cookie = '';
  return {
    async request(urlPath, { method = 'GET', body } = {}) {
      const response = await fetch(`${base}${urlPath}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
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

async function startAiStub() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      const content = JSON.stringify({
        productName: 'Example Domain',
        basis: 'per_100g',
        nutrients: {
          calories: { amount: 250, unit: 'kcal' },
          protein: { amount: 99, unit: 'g' },
        },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('food log, barcode lookup, and product page lookup', { timeout: 120000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fitcalorie-'));
  const ai = await startAiStub();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = ai.url;
  process.env.OPENAI_MODEL = 'test-model';
  const app = createApp({ databasePath: path.join(directory, 'fitcalorie.sqlite') });
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ada = cookieClient(base);
  const ben = cookieClient(base);
  try {
    const health = await ada.request('/api/health');
    assert.equal(health.data.aiConfigured, true);

    const created = await ada.request('/api/auth/register', {
      method: 'POST',
      body: { email: 'ada@example.com', password: 'correct-horse' },
    });
    assert.equal(created.status, 201);
    const other = await ben.request('/api/auth/register', {
      method: 'POST',
      body: { email: 'ben@example.com', password: 'correct-horse' },
    });
    assert.equal(other.status, 201);

    const goals = await ada.request('/api/goals', {
      method: 'PUT',
      body: { targets: { calories: 2000, protein: 50, carbohydrates: 200, fat: 70, fibre: 30 } },
    });
    assert.equal(goals.data.goals.calories, 2000);

    const oats = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        source: 'manual',
        date: '2026-11-18',
        name: 'Oats',
        quantity: 100,
        quantityUnit: 'g',
        basisType: 'per_100g',
        nutrients: {
          calories: { amount: 100, unit: 'kcal' },
          protein: { amount: 3, unit: 'g' },
          iron: { amount: 0, unit: 'mg' },
        },
        idempotencyKey: 'oats-once-001',
      },
    });
    assert.equal(oats.status, 201);
    assert.equal(oats.data.day.totals.calories.amount, 100);
    assert.equal(oats.data.day.totals.iron.amount, 0);
    assert.equal(oats.data.day.totals.vitamin_c.amount, null);

    const again = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        source: 'manual',
        date: '2026-11-18',
        name: 'Oats',
        quantity: 100,
        quantityUnit: 'g',
        basisType: 'per_100g',
        nutrients: { calories: { amount: 100, unit: 'kcal' } },
        idempotencyKey: 'oats-once-001',
      },
    });
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.day.entryCount, 1);

    const yogurt = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        source: 'manual',
        date: '2026-11-18',
        name: 'Yogurt',
        quantity: 150,
        quantityUnit: 'g',
        basisType: 'per_100g',
        nutrients: {
          calories: { amount: 250, unit: 'kcal' },
          protein: { amount: 10, unit: 'g' },
          carbohydrates: { amount: 30, unit: 'g' },
          fat: { amount: 8, unit: 'g' },
          fibre: { amount: 4, unit: 'g' },
          sodium: { amount: 100, unit: 'mg' },
        },
        idempotencyKey: 'yogurt-150-001',
      },
    });
    assert.equal(yogurt.status, 201);
    const yogurtEntry = yogurt.data.entry;
    assert.equal(yogurtEntry.nutrients.calories.amount, 375);
    assert.equal(yogurtEntry.nutrients.protein.amount, 15);
    assert.equal(yogurtEntry.nutrients.carbohydrates.amount, 45);
    assert.equal(yogurtEntry.nutrients.fat.amount, 12);
    assert.equal(yogurtEntry.nutrients.fibre.amount, 6);
    assert.equal(yogurtEntry.nutrients.sodium.amount, 150);
    assert.equal(yogurtEntry.nutrients.vitamin_c, null);
    assert.equal(yogurt.data.day.totals.calories.amount, 475);
    assert.equal(yogurt.data.day.totals.protein.amount, 18);
    assert.equal(yogurt.data.day.goals.calories, 2000);

    const edited = await ada.request(`/api/entries/${oats.data.entry.id}`, {
      method: 'PATCH',
      body: { quantity: 50, quantityUnit: 'g' },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.day.entries.find((entry) => entry.name === 'Oats').calories.amount, 50);
    assert.equal(edited.data.day.totals.calories.amount, 425);

    const yesterday = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        source: 'manual',
        date: '2026-11-17',
        name: 'Apple',
        quantity: 1,
        quantityUnit: 'product',
        basisType: 'portion',
        nutrients: { calories: { amount: 80, unit: 'kcal' } },
        idempotencyKey: 'apple-yesterday',
      },
    });
    assert.equal(yesterday.data.day.date, '2026-11-17');
    assert.equal(yesterday.data.day.totals.calories.amount, 80);
    const today = await ada.request('/api/days/2026-11-18');
    assert.equal(today.data.totals.calories.amount, 425);
    assert.equal(today.data.entries.some((entry) => entry.name === 'Apple'), false);

    const removed = await ada.request(`/api/entries/${yogurtEntry.id}`, { method: 'DELETE' });
    assert.equal(removed.data.day.totals.calories.amount, 50);
    assert.equal(removed.data.day.entries.some((entry) => entry.id === yogurtEntry.id), false);

    const refreshed = await ada.request('/api/days/2026-11-18');
    assert.equal(refreshed.data.entryCount, 1);
    assert.equal(refreshed.data.entries[0].name, 'Oats');

    const hidden = await ben.request('/api/days/2026-11-18');
    assert.equal(hidden.data.entryCount, 0);
    const stolen = await ben.request(`/api/entries/${oats.data.entry.id}`, { method: 'DELETE' });
    assert.equal(stolen.status, 404);
    assert.equal((await ada.request('/api/days/2026-11-18')).data.entryCount, 1);

    await ada.request('/api/auth/logout', { method: 'POST' });
    assert.equal((await ada.request('/api/days/2026-11-18')).status, 401);
    const loggedIn = await ada.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'ada@example.com', password: 'correct-horse' },
    });
    assert.equal(loggedIn.status, 200);
    assert.equal((await ada.request('/api/days/2026-11-18')).data.entries[0].name, 'Oats');

    const nutella = await ada.request('/api/lookup/barcode', {
      method: 'POST',
      body: { barcode: '3017 620422 003' },
    });
    assert.equal(nutella.status, 200, JSON.stringify(nutella.data));
    assert.equal(nutella.data.product.name.toLowerCase().includes('nutella'), true);
    assert.equal(nutella.data.product.basis.type, 'per_100g');
    assert.equal(nutella.data.product.nutrients.calories.amount, 539);
    assert.equal(nutella.data.product.nutrients.fibre.amount, 0);
    assert.equal(nutella.data.product.nutrients.vitamin_c, null);
    assert.equal(nutella.data.product.provenance.provider, 'openfoodfacts');
    assert.ok(nutella.data.reviewToken);

    const added = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        date: '2026-11-18',
        quantity: 150,
        quantityUnit: 'g',
        reviewToken: nutella.data.reviewToken,
        idempotencyKey: 'nutella-150',
      },
    });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    assert.equal(added.data.entry.nutrients.calories.amount, 808.5);
    assert.equal(added.data.entry.nutrients.protein.amount, 9.45);
    assert.equal(added.data.day.totals.calories.amount, 858.5);

    const cola = await ada.request('/api/lookup/barcode', { method: 'POST', body: { barcode: '5449000000996' } });
    assert.equal(cola.status, 200, JSON.stringify(cola.data));
    const can = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        date: '2026-11-16',
        quantity: 1,
        quantityUnit: 'serving',
        reviewToken: cola.data.reviewToken,
        idempotencyKey: 'cola-one-can',
      },
    });
    assert.equal(can.status, 201, JSON.stringify(can.data));
    assert.equal(can.data.entry.nutrients.calories.amount, 145);
    assert.equal(can.data.entry.nutrients.fat.amount, 0);

    assert.equal((await ada.request('/api/lookup/barcode', { method: 'POST', body: { barcode: 'abc' } })).status, 400);
    const missing = await ada.request('/api/lookup/barcode', { method: 'POST', body: { barcode: '4000000000000' } });
    assert.equal(missing.status, 404);
    const invalid = await ada.request('/api/lookup/barcode', { method: 'POST', body: { barcode: '0000000000000' } });
    assert.equal(invalid.status, 400);

    const callsBeforePage = ai.requests.length;
    const page = await ada.request('/api/lookup/url', {
      method: 'POST',
      body: { url: 'https://world.openfoodfacts.org/product/3017620422003' },
    });
    assert.equal(page.status, 200, JSON.stringify(page.data));
    assert.equal(page.data.product.name.toLowerCase().includes('nutella'), true);
    assert.equal(page.data.product.nutrients.calories.amount, 539);
    assert.equal(page.data.product.nutrients.fibre.amount, 0);
    assert.equal(page.data.product.basis.type, 'per_100g');
    assert.equal(page.data.product.provenance.provider, 'page_structured');
    assert.equal(ai.requests.length, callsBeforePage);

    assert.equal((await ada.request('/api/lookup/url', { method: 'POST', body: { url: 'not a url' } })).status, 400);
    const blocked = await ada.request('/api/lookup/url', { method: 'POST', body: { url: 'http://127.0.0.1/secret' } });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.data.code, 'BLOCKED_URL');
    const unreachable = await ada.request('/api/lookup/url', { method: 'POST', body: { url: 'https://example.invalid/product' } });
    assert.equal(unreachable.status, 422);
    assert.equal(unreachable.data.code, 'UNREACHABLE');

    const bare = await ada.request('/api/lookup/url', { method: 'POST', body: { url: 'https://example.com' } });
    assert.equal(bare.status, 422);
    assert.equal(bare.data.code, 'NUTRITION_UNAVAILABLE');
    assert.equal(/estimated|not configured|verified/i.test(bare.data.error), true);
    assert.equal(ai.requests.length, callsBeforePage + 1);
    assert.equal(ai.requests.at(-1).authorization, 'Bearer test-key');
    assert.equal(ai.requests.at(-1).body.messages.some((message) => /Example Domain/.test(message.content)), true);
    assert.equal(JSON.stringify(bare.data).includes('250'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.close();
    await ai.close();
    delete process.env.OPENAI_API_KEY;
  }
});
