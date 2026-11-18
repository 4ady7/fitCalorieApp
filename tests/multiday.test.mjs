import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { roundAmount, shiftDate, todayISO } from '../shared/nutrients.js';

process.env.SCRYPT_N = '1024';

const WEEK = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'];
const BARCODE = '5000111122223';

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
      return { status: response.status, data: text ? JSON.parse(text) : null, cookie };
    },
  };
}

function nutrient(amount, unit) {
  return amount == null ? null : { amount, unit };
}

function manualBody(date, name, key, values) {
  return {
    source: 'manual',
    date,
    name,
    quantity: 1,
    quantityUnit: 'product',
    basisType: 'portion',
    nutrients: {
      calories: nutrient(values.calories, 'kcal'),
      protein: nutrient(values.protein, 'g'),
      carbohydrates: nutrient(values.carbohydrates, 'g'),
      fat: nutrient(values.fat, 'g'),
      saturated_fat: nutrient(values.saturated_fat, 'g'),
      fibre: nutrient(values.fibre, 'g'),
      sugars: nutrient(values.sugars, 'g'),
      salt: nutrient(values.salt, 'g'),
      sodium: nutrient(values.sodium, 'mg'),
      iron: nutrient(values.iron, 'mg'),
      calcium: nutrient(values.calcium, 'mg'),
      vitamin_c: nutrient(values.vitamin_c, 'mg'),
      vitamin_d: nutrient(values.vitamin_d, 'µg'),
      vitamin_b12: nutrient(values.vitamin_b12, 'µg'),
    },
    idempotencyKey: key,
  };
}

const FOOD = {
  banana: { calories: 105, protein: 1.3, carbohydrates: 27, fat: 0.3, saturated_fat: 0.1, fibre: 3.1, sugars: 14, salt: 0, sodium: 1, iron: 0.3, vitamin_c: 8.7 },
  tikka: { calories: 566, protein: 29.1, carbohydrates: 66.9, fat: 19.3, saturated_fat: 5.7, fibre: 4.2, sugars: 11.7, salt: 1.81 },
  yogurt: { calories: 150, protein: 15, carbohydrates: 6, fat: 8, saturated_fat: 5, fibre: 0, sugars: 6, salt: 0.2, calcium: 200 },
  macaroni: { calories: 739, protein: 30.4, carbohydrates: 76.5, fat: 33.7, saturated_fat: 16.9, fibre: 4, sugars: 5.9, salt: 1.16 },
  apple: { calories: 95, protein: 0.5, carbohydrates: 25, fat: 0.3, saturated_fat: 0, fibre: 4.4, sugars: 19, salt: 0, vitamin_c: 8 },
  cauliflower: { calories: 220, protein: 9.9, carbohydrates: 7.9, fat: 16.3, saturated_fat: 10.5, fibre: 1.4, sugars: 2.9, salt: 0.81 },
  chicken: { calories: 250, protein: 45, carbohydrates: 0, fat: 6, saturated_fat: 1.7, fibre: 0, sugars: 0, salt: 0.2, sodium: 74 },
  oatmeal: { calories: 300, protein: 10, carbohydrates: 54, fat: 6, saturated_fat: 1, fibre: 8, sugars: 1, salt: 0.01 },
  salmon: { calories: 350, protein: 34, carbohydrates: 0, fat: 22, saturated_fat: 4, fibre: 0, sugars: 0, salt: 0.15, vitamin_d: 10.5 },
  rice: { calories: 650, protein: 40, carbohydrates: 70, fat: 18, saturated_fat: 4, fibre: 2, sugars: 1, salt: 1.2 },
  pasta: { calories: 550, protein: 20, carbohydrates: 80, fat: 15, saturated_fat: 6, fibre: 4, sugars: 6, salt: 1.1 },
  eggs: { calories: 155, protein: 13, carbohydrates: 1.1, fat: 11, saturated_fat: 3.3, fibre: 0, sugars: 1.1, salt: 0.4, vitamin_b12: 1.1 },
  soup: { calories: 200, protein: 10, carbohydrates: 15, fat: 8, saturated_fat: 2, fibre: 1, sugars: 2, salt: 0.8 },
  toast: { calories: 180, protein: 6, carbohydrates: 30, fat: 3, saturated_fat: 0.5, fibre: 2, sugars: 3, salt: 0.4 },
  salad: { calories: 120, protein: 4, carbohydrates: 8, fat: 7, saturated_fat: 1, fibre: 3, sugars: 4, salt: 0.3 },
  orange: { calories: 80, protein: 1, carbohydrates: 21, fat: 0.2, saturated_fat: 0, fibre: 3, sugars: 16, salt: 0, vitamin_c: 70 },
};

const EXPECTED = {
  '2026-11-09': { calories: 374, protein: 40.5, carbohydrates: 33.6, fat: 9.7, saturated_fat: 4.2, fibre: 4.1, sugars: 20.4, salt: 1.05, sodium: 1, iron: 1.1, vitamin_c: 8.7, calcium: null },
  '2026-11-10': { calories: 716, protein: 44.1, carbohydrates: 72.9, fat: 27.3, saturated_fat: 10.7, fibre: 4.2, sugars: 17.7, salt: 2.01, calcium: 200, sodium: null },
  '2026-11-11': { calories: 834, protein: 30.9, carbohydrates: 101.5, fat: 34, saturated_fat: 16.9, fibre: 8.4, sugars: 24.9, salt: 1.16, vitamin_c: 8, sodium: null },
  '2026-11-12': { calories: 470, protein: 54.9, carbohydrates: 7.9, fat: 22.3, saturated_fat: 12.2, fibre: 1.4, sugars: 2.9, salt: 1.01, sodium: 74 },
  '2026-11-13': { calories: 650, protein: 44, carbohydrates: 54, fat: 28, saturated_fat: 5, fibre: 8, sugars: 1, salt: 0.16, vitamin_d: 10.5 },
  '2026-11-14': { calories: 755, protein: 41.3, carbohydrates: 97, fat: 18.3, saturated_fat: 4.1, fibre: 5.1, sugars: 15, salt: 1.2, sodium: 1, iron: 0.3, vitamin_c: 8.7 },
  '2026-11-15': { calories: 705, protein: 33, carbohydrates: 81.1, fat: 26, saturated_fat: 9.3, fibre: 4, sugars: 7.1, salt: 1.5, vitamin_b12: 1.1 },
};

function sqlTotals(db, userId, date) {
  return db.prepare(`
    SELECT n.nutrient_key AS key, SUM(n.amount) AS amount, COUNT(n.amount) AS known, COUNT(*) AS rows
    FROM food_entry_nutrients n
    JOIN food_entries e ON e.id = n.entry_id
    WHERE e.user_id = ? AND e.entry_date = ?
    GROUP BY n.nutrient_key
  `).all(userId, date);
}

function listen(app) {
  const server = app.app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

test('local dates stay on the calendar day across midnight and daylight-saving changes', () => {
  const late = new Date(2026, 10, 18, 23, 30, 0);
  const early = new Date(2026, 10, 19, 0, 30, 0);
  assert.equal(todayISO(late), '2026-11-18');
  assert.equal(todayISO(early), '2026-11-19');
  assert.equal(shiftDate('2026-11-09', 1), '2026-11-10');
  assert.equal(shiftDate('2026-11-15', -6), '2026-11-09');

  for (const zone of ['Europe/London', 'America/New_York']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { shiftDate, todayISO } from './shared/nutrients.js';
      import assert from 'node:assert/strict';
      assert.equal(shiftDate('2026-03-28', 1), '2026-03-29');
      assert.equal(shiftDate('2026-03-29', 1), '2026-03-30');
      assert.equal(shiftDate('2026-10-24', 1), '2026-10-25');
      assert.equal(shiftDate('2026-10-25', 1), '2026-10-26');
      assert.equal(todayISO(new Date(2026, 2, 29, 0, 30)), '2026-03-29');
      assert.equal(todayISO(new Date(2026, 2, 28, 23, 30)), '2026-03-28');
    `], { cwd: process.cwd(), env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(child.status, 0, `${zone}\n${child.stderr}`);
  }
});

test('seven-day log stays date-specific, editable, and private', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fitcalorie-week-'));
  const databasePath = path.join(directory, 'fitcalorie.sqlite');
  const secret = 'multiday-test-secret';
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('openfoodfacts.org')) {
      return new Response(JSON.stringify({
        status: 1,
        code: BARCODE,
        product: {
          code: BARCODE,
          product_name: 'Hunters Chicken',
          brands: 'Test Kitchen',
          nutrition_data_per: 'serving',
          nutriments: {
            'energy-kcal_serving': 269,
            proteins_serving: 39.2,
            carbohydrates_serving: 6.6,
            fat_serving: 9.4,
            'saturated-fat_serving': 4.1,
            fiber_serving: 1,
            sugars_serving: 6.4,
            salt_serving: 1.05,
            iron_serving: 0.8,
            iron_unit: 'mg',
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(url, options);
  };

  let app = createApp({ databasePath, secret });
  let server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const ada = cookieClient(base);
  const ben = cookieClient(base);
  try {
    assert.equal((await ada.request('/api/auth/register', { method: 'POST', body: { email: 'week.ada@example.com', password: 'correct-horse' } })).status, 201);
    assert.equal((await ben.request('/api/auth/register', { method: 'POST', body: { email: 'week.ben@example.com', password: 'correct-horse' } })).status, 201);
    const adaId = app.db.prepare('SELECT id FROM users WHERE email = ?').get('week.ada@example.com').id;
    const benId = app.db.prepare('SELECT id FROM users WHERE email = ?').get('week.ben@example.com').id;

    const huntersLookup = await ada.request('/api/lookup/barcode', { method: 'POST', body: { barcode: BARCODE } });
    assert.equal(huntersLookup.status, 200);
    assert.equal(huntersLookup.data.product.nutrients.calories.amount, 269);
    assert.equal(huntersLookup.data.product.nutrients.vitamin_c, null);
    const hunters = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        reviewToken: huntersLookup.data.reviewToken,
        date: '2026-11-09',
        quantity: 1,
        quantityUnit: 'serving',
        idempotencyKey: 'ada-hunters-mon',
      },
    });
    assert.equal(hunters.status, 201);
    assert.equal(hunters.data.entry.calories.amount, 269);
    assert.equal(hunters.data.entry.nutrients.sodium, null);

    const plan = [
      ['2026-11-09', 'Banana', 'ada-banana-mon', FOOD.banana],
      ['2026-11-10', 'Chicken Tikka Masala', 'ada-tikka-tue', FOOD.tikka],
      ['2026-11-10', 'Greek Yoghurt', 'ada-yogurt-tue', FOOD.yogurt],
      ['2026-11-11', 'Macaroni Cheese', 'ada-mac-wed', FOOD.macaroni],
      ['2026-11-11', 'Apple', 'ada-apple-wed', FOOD.apple],
      ['2026-11-12', 'Cauliflower Cheese', 'ada-cauli-thu', FOOD.cauliflower],
      ['2026-11-12', 'Chicken Breast', 'ada-chicken-thu', FOOD.chicken],
      ['2026-11-13', 'Oatmeal', 'ada-oats-fri', FOOD.oatmeal],
      ['2026-11-13', 'Salmon', 'ada-salmon-fri', FOOD.salmon],
      ['2026-11-14', 'Rice and Chicken', 'ada-rice-sat', FOOD.rice],
      ['2026-11-14', 'Banana', 'ada-banana-sat', FOOD.banana],
      ['2026-11-15', 'Pasta', 'ada-pasta-sun', FOOD.pasta],
      ['2026-11-15', 'Eggs', 'ada-eggs-sun', FOOD.eggs],
    ];
    for (const [date, name, key, values] of plan) {
      const saved = await ada.request('/api/entries', { method: 'POST', body: manualBody(date, name, key, values) });
      assert.equal(saved.status, 201, `${name} ${saved.data?.error || ''}`);
      assert.equal(saved.data.entry.date, date);
    }
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM food_entries WHERE user_id = ?').get(adaId).count, 14);

    for (const date of WEEK) {
      const day = await ada.request(`/api/days/${date}`);
      assert.equal(day.status, 200);
      assert.equal(day.data.date, date);
      assert.equal(day.data.entries.length, 2);
      assert.equal(day.data.entries.every((entry) => entry.date === date), true);
      const expected = EXPECTED[date];
      for (const [key, amount] of Object.entries(expected)) {
        assert.equal(day.data.totals[key].amount, amount, `${date} ${key}`);
      }
      const rows = sqlTotals(app.db, adaId, date);
      for (const [key, amount] of Object.entries(expected)) {
        const row = rows.find((item) => item.key === key);
        if (amount == null) assert.equal(row.known, 0, `${date} ${key} should stay null`);
        else assert.equal(roundAmount(row.amount), amount, `sql ${date} ${key}`);
      }
      const neighbour = date === WEEK[0] ? WEEK[1] : shiftDate(date, -1);
      assert.equal(day.data.entries.some((entry) => entry.date === neighbour), false);
    }

    const mondayNames = (await ada.request('/api/days/2026-11-09')).data.entries.map((entry) => entry.name).sort();
    assert.deepEqual(mondayNames, ['Banana', 'Hunters Chicken']);
    const tuesdayNames = (await ada.request('/api/days/2026-11-10')).data.entries.map((entry) => entry.name);
    assert.equal(tuesdayNames.includes('Hunters Chicken'), false);
    assert.equal(tuesdayNames.includes('Banana'), false);

    const firstGoals = await ada.request('/api/goals', {
      method: 'PUT',
      body: { effectiveDate: '2026-11-09', targets: { calories: 2200, protein: 120, carbohydrates: 250, fat: 70 }, userId: benId },
    });
    assert.equal(firstGoals.data.goals.calories, 2200);
    const nextGoals = await ada.request('/api/goals', {
      method: 'PUT',
      body: { effectiveDate: '2026-11-12', targets: { calories: 1800, protein: 140, carbohydrates: 180, fat: 55 } },
    });
    assert.equal(nextGoals.data.goals.calories, 1800);
    assert.equal((await ada.request('/api/days/2026-11-11')).data.goals.calories, 2200);
    assert.equal((await ada.request('/api/days/2026-11-11')).data.goals.protein, 120);
    assert.equal((await ada.request('/api/days/2026-11-12')).data.goals.calories, 1800);
    assert.equal((await ada.request('/api/days/2026-11-15')).data.goals.fat, 55);
    assert.equal((await ada.request('/api/days/2026-11-18')).data.goals.calories, 1800);
    assert.equal((await ada.request('/api/days/2026-11-09')).data.totals.calories.amount, 374);

    const eggs = (await ada.request('/api/days/2026-11-15')).data.entries.find((entry) => entry.name === 'Eggs');
    const edited = await ada.request(`/api/entries/${eggs.id}`, { method: 'PATCH', body: { quantity: 2, quantityUnit: 'product' } });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.day.date, '2026-11-15');
    assert.equal(edited.data.day.totals.calories.amount, 860);
    assert.equal(edited.data.day.totals.protein.amount, 46);
    assert.equal(edited.data.day.totals.vitamin_b12.amount, 2.2);
    assert.equal((await ada.request('/api/days/2026-11-14')).data.totals.calories.amount, 755);
    assert.equal((await ada.request('/api/days/2026-11-18')).data.totals.calories.amount, null);
    const reference = app.db.prepare(`
      SELECT amount FROM product_nutrients
      WHERE nutrient_key = 'calories' AND scope = 'reference'
        AND product_id = (SELECT id FROM products WHERE barcode = ?)
    `).get(BARCODE);
    assert.equal(reference.amount, 269);

    const removed = await ada.request(`/api/entries/${eggs.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.day.entries.some((entry) => entry.name === 'Eggs'), false);
    assert.equal(removed.data.day.totals.calories.amount, 550);
    assert.equal(removed.data.day.totals.vitamin_b12.amount, null);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM food_entry_nutrients WHERE entry_id = ?').get(eggs.id).count, 0);
    assert.equal((await ada.request('/api/days/2026-11-09')).data.totals.calories.amount, 374);

    const orange = await ada.request('/api/entries', {
      method: 'POST',
      body: manualBody('2026-11-11', 'Orange', 'ada-orange-wed', FOOD.orange),
    });
    assert.equal(orange.status, 201);
    assert.equal(orange.data.day.totals.calories.amount, 914);
    assert.equal(orange.data.day.totals.vitamin_c.amount, 78);
    assert.equal((await ada.request('/api/days/2026-11-10')).data.totals.calories.amount, 716);
    assert.equal((await ada.request('/api/days/2026-11-18')).data.entryCount, 0);

    const benLookup = await ben.request('/api/lookup/barcode', { method: 'POST', body: { barcode: BARCODE } });
    assert.equal(benLookup.data.product.catalogId, huntersLookup.data.product.catalogId);
    assert.equal(JSON.stringify(benLookup.data.product).includes('week.ada@example.com'), false);
    const benHunters = await ben.request('/api/entries', {
      method: 'POST',
      body: {
        reviewToken: benLookup.data.reviewToken,
        date: '2026-11-09',
        quantity: 1,
        quantityUnit: 'serving',
        idempotencyKey: 'ben-hunters-mon',
        userId: adaId,
      },
    });
    assert.equal(benHunters.status, 201);
    await ben.request('/api/entries', { method: 'POST', body: manualBody('2026-11-09', 'Soup', 'ben-soup-mon', FOOD.soup) });
    await ben.request('/api/entries', { method: 'POST', body: manualBody('2026-11-10', 'Toast', 'ben-toast-tue', FOOD.toast) });
    await ben.request('/api/entries', { method: 'POST', body: manualBody('2026-11-11', 'Salad', 'ben-salad-wed', FOOD.salad) });
    await ben.request('/api/goals', { method: 'PUT', body: { effectiveDate: '2026-11-09', targets: { calories: 1600 }, userId: adaId } });

    const benMonday = await ben.request('/api/days/2026-11-09');
    const adaMonday = await ada.request('/api/days/2026-11-09');
    assert.deepEqual(benMonday.data.entries.map((entry) => entry.name).sort(), ['Hunters Chicken', 'Soup']);
    assert.equal(benMonday.data.totals.calories.amount, 469);
    assert.equal(benMonday.data.goals.calories, 1600);
    assert.equal(adaMonday.data.totals.calories.amount, 374);
    assert.equal(adaMonday.data.goals.calories, 2200);
    assert.equal(adaMonday.data.entries.some((entry) => entry.name === 'Soup'), false);
    assert.equal((await ben.request(`/api/entries/${adaMonday.data.entries[0].id}`, { method: 'PATCH', body: { quantity: 9 } })).status, 404);
    assert.equal((await ben.request(`/api/entries/${adaMonday.data.entries[0].id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await ada.request('/api/days/2026-11-10')).data.entries.some((entry) => entry.name === 'Toast'), false);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM products WHERE barcode = ?').get(BARCODE).count, 1);

    const replay = await ada.request('/api/entries', { method: 'POST', body: manualBody('2026-11-16', 'Oatmeal', 'ada-oats-replay', FOOD.oatmeal) });
    const replayAgain = await ada.request('/api/entries', { method: 'POST', body: manualBody('2026-11-16', 'Oatmeal', 'ada-oats-replay', FOOD.oatmeal) });
    assert.equal(replay.status, 201);
    assert.equal(replayAgain.status, 200);
    assert.equal(replayAgain.data.duplicate, true);
    assert.equal(replayAgain.data.entry.id, replay.data.entry.id);
    const secondOatmeal = await ada.request('/api/entries', { method: 'POST', body: manualBody('2026-11-16', 'Oatmeal', 'ada-oats-intentional', FOOD.oatmeal) });
    assert.equal(secondOatmeal.status, 201);
    assert.equal((await ada.request('/api/days/2026-11-16')).data.entryCount, 2);
    assert.equal((await ada.request('/api/days/2026-11-16')).data.totals.calories.amount, 600);
    const huntersAgain = await ada.request('/api/entries', {
      method: 'POST',
      body: {
        reviewToken: huntersLookup.data.reviewToken,
        date: '2026-11-16',
        quantity: 1,
        quantityUnit: 'serving',
        idempotencyKey: 'ada-hunters-spare',
      },
    });
    assert.equal(huntersAgain.status, 201);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM products WHERE barcode = ?').get(BARCODE).count, 1);

    const [raced, racedAgain] = await Promise.all([
      ada.request('/api/entries', { method: 'POST', body: manualBody('2026-11-17', 'Late cocoa', 'ada-late-cocoa', { calories: 40, protein: 1, carbohydrates: 6, fat: 1, saturated_fat: 0.6, fibre: 0, sugars: 5, salt: 0.05 }) }),
      ada.request('/api/entries', { method: 'POST', body: manualBody('2026-11-17', 'Late cocoa', 'ada-late-cocoa', { calories: 40, protein: 1, carbohydrates: 6, fat: 1, saturated_fat: 0.6, fibre: 0, sugars: 5, salt: 0.05 }) }),
    ]);
    assert.equal([raced.status, racedAgain.status].sort().join(','), '200,201');
    assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM food_entries WHERE user_id = ? AND name = 'Late cocoa'`).get(adaId).count, 1);
    const early = await ada.request('/api/entries', { method: 'POST', body: manualBody('2026-11-18', 'Early coffee', 'ada-early-coffee', { calories: 5, protein: 0.3, carbohydrates: 0, fat: 0, saturated_fat: 0, fibre: 0, sugars: 0, salt: 0.01 }) });
    assert.equal(early.status, 201);
    const lateRow = app.db.prepare(`SELECT entry_date, consumed_at FROM food_entries WHERE user_id = ? AND name = 'Late cocoa'`).get(adaId);
    const earlyRow = app.db.prepare(`SELECT entry_date, consumed_at FROM food_entries WHERE user_id = ? AND name = 'Early coffee'`).get(adaId);
    assert.equal(lateRow.entry_date, '2026-11-17');
    assert.equal(earlyRow.entry_date, '2026-11-18');
    assert.equal(lateRow.consumed_at, '2026-11-17T12:00:00.000Z');
    assert.equal((await ada.request('/api/days/2026-11-17')).data.entries.some((entry) => entry.name === 'Early coffee'), false);
    assert.equal((await ada.request('/api/days/2026-11-18')).data.entries.some((entry) => entry.name === 'Late cocoa'), false);
    const london = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(lateRow.consumed_at));
    const auckland = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(lateRow.consumed_at));
    assert.equal(london, '2026-11-17');
    assert.notEqual(auckland, london);

    assert.equal((await ada.request('/api/days/2026-02-31')).status, 400);
    assert.throws(() => app.db.prepare(`
      INSERT INTO food_entries (
        id, user_id, entry_date, consumed_at, name, quantity, quantity_unit, calories_kcal,
        snapshot_json, consumed_json, provenance_json, idempotency_key, created_at, updated_at
      ) VALUES ('bad', 'missing-user', '2026-11-09', '2026-11-09T12:00:00.000Z', 'Nope', 1, 'g', 1, '{}', '{}', '{}', 'bad-key', '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z')
    `).run());

    const beforeRestart = app.db.prepare('SELECT COUNT(*) AS count FROM food_entries').get().count;
    const adaCookie = (await ada.request('/api/auth/me')).cookie;
    assert.equal(beforeRestart, 23);

    await new Promise((resolve) => server.close(resolve));
    app.close();
    app = createApp({ databasePath, secret });
    server = await listen(app);
    const restarted = cookieClient(`http://127.0.0.1:${server.address().port}`);
    const loggedOut = await restarted.request('/api/days/2026-11-09');
    assert.equal(loggedOut.status, 401);
    const signedIn = await restarted.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'week.ada@example.com', password: 'correct-horse' },
    });
    assert.equal(signedIn.status, 200);
    const persisted = await restarted.request('/api/days/2026-11-09');
    assert.deepEqual(persisted.data.entries.map((entry) => entry.name).sort(), ['Banana', 'Hunters Chicken']);
    assert.equal(persisted.data.totals.calories.amount, 374);
    assert.equal(persisted.data.goals.calories, 2200);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM food_entries').get().count, beforeRestart);
    assert.equal(app.db.prepare('SELECT user_id FROM food_entries WHERE name = ? AND entry_date = ?').get('Soup', '2026-11-09').user_id, benId);
    assert.ok(adaCookie);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    app.close();
  }
});
