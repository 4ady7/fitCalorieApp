import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { mapOffProduct } from '../server/openfoodfacts.js';
import { buildAnalytics, inclusiveDays, periodWindows, shiftMonths } from '../shared/analytics.js';
import { evaluateIntake, profileFor } from '../shared/goals.js';
import { roundAmount, shiftDate } from '../shared/nutrients.js';

process.env.SCRYPT_N = '1024';

const UNITS = {
  calories: 'kcal',
  protein: 'g',
  carbohydrates: 'g',
  fat: 'g',
  saturated_fat: 'g',
  unsaturated_fat: 'g',
  monounsaturated_fat: 'g',
  polyunsaturated_fat: 'g',
  fibre: 'g',
  sugars: 'g',
  added_sugars: 'g',
  salt: 'g',
  sodium: 'mg',
};

function cookieClient(base) {
  let cookie = '';
  return {
    async request(urlPath, { method = 'GET', body } = {}) {
      const response = await fetch(`${base}${urlPath}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json', origin: base } : {}),
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

function manualBody(date, name, key, values) {
  const nutrients = {};
  for (const [nutrient, amount] of Object.entries(values)) {
    nutrients[nutrient] = amount == null ? null : { amount, unit: UNITS[nutrient] };
  }
  return {
    source: 'manual',
    date,
    name,
    quantity: 1,
    quantityUnit: 'product',
    basisType: 'portion',
    nutrients,
    idempotencyKey: key,
  };
}

function listen(app) {
  const server = app.app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

test('comparison windows use elapsed calendar periods', () => {
  assert.equal(shiftMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(shiftMonths('2024-03-31', -1), '2024-02-29');
  const windows = periodWindows('2026-11-18');
  assert.equal(windows.week.current.start, '2026-11-16');
  assert.equal(windows.week.previous.end, '2026-11-11');
  assert.equal(windows.month.previous.end, '2026-10-18');
  assert.equal(windows.year.current.start, '2026-01-01');
  assert.equal(windows.year.previous.end, '2025-11-18');
  assert.equal(inclusiveDays(windows.week.current.start, windows.week.current.end).length, 3);
  assert.equal(inclusiveDays(windows.week.previous.start, windows.week.previous.end).length, 3);
});

test('goal judgements follow the nutrient type and never treat a gap as zero', () => {
  const protein = profileFor('protein');
  const salt = profileFor('salt');
  const calories = profileFor('calories');
  const water = profileFor('water');
  assert.equal(evaluateIntake(protein, { kind: 'minimum', amount: 50 }, 80, { logged: true }).status, 'achieved');
  assert.equal(evaluateIntake(protein, { kind: 'minimum', amount: 50 }, 20, { logged: true }).status, 'below');
  assert.equal(evaluateIntake(protein, { kind: 'minimum', amount: 50 }, 80, { logged: true, partial: true }).status, 'achieved');
  assert.equal(evaluateIntake(protein, { kind: 'minimum', amount: 50 }, 20, { logged: true, partial: true }).success, null);
  assert.equal(evaluateIntake(salt, { kind: 'maximum', amount: 6 }, 7, { logged: true }).status, 'exceeding');
  assert.equal(evaluateIntake(salt, { kind: 'maximum', amount: 6 }, 7, { logged: true }).success, false);
  assert.equal(evaluateIntake(salt, { kind: 'maximum', amount: 6 }, 2, { logged: true, partial: true }).status, 'insufficient');
  assert.equal(evaluateIntake(salt, { kind: 'maximum', amount: 6 }, 7, { logged: true, partial: true }).status, 'exceeding');
  assert.equal(evaluateIntake(calories, { kind: 'target', amount: 2200 }, 2150, { logged: true }).status, 'achieved');
  assert.equal(evaluateIntake(calories, { kind: 'target', amount: 2200 }, 1950, { logged: true }).status, 'below');
  assert.equal(evaluateIntake(calories, { kind: 'range', min: 1800, max: 2200 }, 2300, { logged: true }).status, 'above');
  assert.equal(evaluateIntake(calories, { kind: 'range', min: 1800, max: 2200 }, 2000, { logged: true }).status, 'within');
  assert.equal(evaluateIntake(water, { kind: 'target', amount: 2000 }, 750, { logged: true }).status, 'below');
  assert.equal(evaluateIntake(salt, { kind: 'maximum', amount: 6 }, null, { logged: true }).status, 'insufficient');
  assert.equal(evaluateIntake(salt, { kind: 'maximum', amount: 6 }, 0, { logged: false }).status, 'unlogged');

  const report = buildAnalytics({
    asOf: '2026-11-18',
    goals: [{
      effectiveDate: '2026-01-01',
      details: {
        protein: { kind: 'minimum', amount: 50, min: null, max: null },
        salt: { kind: 'maximum', amount: 6, min: null, max: null },
      },
    }],
    days: [
      { date: '2026-11-16', foodEntries: 1, nutrients: { protein: { amount: 10, known: 1 } }, water: null },
      { date: '2026-11-18', foodEntries: 2, nutrients: { protein: { amount: 30, known: 1 }, salt: { amount: 1, known: 1 } }, water: null },
    ],
  });
  assert.equal(report.nutrients.protein.averages.week.amount, 20);
  assert.equal(report.nutrients.protein.averages.week.coveredDays, 2);
  assert.equal(report.periods.week.nutrients.protein.current.calendarDays, 3);
  assert.equal(report.periods.day.nutrients.salt.current.status, 'insufficient');
  assert.equal(report.nutrients.unsaturated_fat.today.total, null);
  assert.equal(report.periods.month.overall.calories.previous.total, null);
});

test('open food facts keeps unsaturated fat, added sugars, salt, and sodium distinct', () => {
  const product = mapOffProduct({
    product_name: 'Mixed nuts',
    nutriments: {
      'energy-kcal_100g': 600,
      'monounsaturated-fat_100g': 20,
      'polyunsaturated-fat_100g': 8,
      sugars_100g: 6,
      'added-sugars_100g': 1,
      salt_100g: 0.2,
      sodium_100g: 0.08,
    },
  });
  assert.equal(product.nutrients.unsaturated_fat, null);
  assert.equal(product.nutrients.monounsaturated_fat.amount, 20);
  assert.equal(product.nutrients.polyunsaturated_fat.amount, 8);
  assert.equal(product.nutrients.sugars.amount, 6);
  assert.equal(product.nutrients.added_sugars.amount, 1);
  assert.equal(product.nutrients.salt.amount, 0.2);
  assert.equal(product.nutrients.sodium.amount, 80);
  assert.notEqual(product.nutrients.salt.amount + product.nutrients.sodium.amount, product.nutrients.salt.amount);
});

test('analytics reads persisted meals, water, goals, and seven years of history', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fitcalorie-analytics-'));
  const app = createApp({ databasePath: path.join(directory, 'fitcalorie.sqlite'), secret: 'analytics-test-secret' });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const ada = cookieClient(base);
  const ben = cookieClient(base);
  const bulk = cookieClient(base);
  try {
    assert.equal((await ada.request('/api/analytics?asOf=2026-11-18')).status, 401);
    assert.equal((await ada.request('/api/auth/register', { method: 'POST', body: { email: 'analytics.ada@example.com', password: 'correct-horse' } })).status, 201);
    assert.equal((await ben.request('/api/auth/register', { method: 'POST', body: { email: 'analytics.ben@example.com', password: 'correct-horse' } })).status, 201);
    assert.equal((await bulk.request('/api/auth/register', { method: 'POST', body: { email: 'analytics.bulk@example.com', password: 'correct-horse' } })).status, 201);
    assert.equal((await ada.request('/api/analytics?asOf=2026-13-40')).status, 400);

    const earlierGoals = await ada.request('/api/goals', {
      method: 'PUT',
      body: {
        effectiveDate: '2026-01-01',
        targets: { calories: 2200, protein: 100, carbohydrates: 220, fat: 70, fibre: 30, sugars: 50, salt: 6, saturated_fat: 20, water: 2500 },
      },
    });
    assert.equal(earlierGoals.data.goals.protein, 100);
    assert.equal(earlierGoals.data.goalDetails.protein.kind, 'minimum');
    assert.equal(earlierGoals.data.goalDetails.salt.kind, 'maximum');
    const todayGoals = await ada.request('/api/goals', {
      method: 'PUT',
      body: {
        effectiveDate: '2026-11-18',
        targets: {
          calories: 2200,
          protein: 80,
          carbohydrates: 250,
          fat: 70,
          fibre: 25,
          sugars: 50,
          added_sugars: 10,
          salt: 6,
          saturated_fat: 20,
          water: 2000,
        },
      },
    });
    assert.equal(todayGoals.data.goals.water, 2000);
    assert.equal((await ada.request('/api/days/2026-11-17')).data.goals.protein, 100);
    assert.equal((await ada.request('/api/days/2026-11-18')).data.goals.protein, 80);

    const foods = [
      ['2026-11-09', 'Monday last week', 'ada-nov-09', { calories: 2100, protein: 80, carbohydrates: 90, fat: 30, fibre: 10, sugars: 20, salt: 1, saturated_fat: 4 }],
      ['2026-11-10', 'Tuesday last week', 'ada-nov-10', { calories: 2000, protein: 80, carbohydrates: 90, fat: 30, fibre: 10, sugars: 20, salt: 1, saturated_fat: 4 }],
      ['2026-11-11', 'Wednesday last week', 'ada-nov-11', { calories: 1900, protein: 80, carbohydrates: 90, fat: 30, fibre: 10, sugars: 20, salt: 1, saturated_fat: 4 }],
      ['2026-11-16', 'Monday this week', 'ada-nov-16', { calories: 1800, protein: 110, carbohydrates: 100, fat: 40, fibre: 40, sugars: 10, saturated_fat: 5 }],
      ['2026-11-17', 'Yesterday meal', 'ada-nov-17', { calories: 1950, protein: 90, carbohydrates: 200, fat: 60, fibre: 20, sugars: 40, salt: 2, saturated_fat: 10, unsaturated_fat: 12 }],
      ['2026-11-18', 'Today meal', 'ada-nov-18', { calories: 2150, protein: 90, carbohydrates: 180, fat: 70, fibre: 22, sugars: 35, added_sugars: 8, salt: 7, sodium: 800, saturated_fat: 22, monounsaturated_fat: 5, polyunsaturated_fat: 2 }],
    ];
    let todayEntry = null;
    for (const [date, name, key, values] of foods) {
      const saved = await ada.request('/api/entries', { method: 'POST', body: manualBody(date, name, key, values) });
      assert.equal(saved.status, 201, saved.data?.error);
      if (date === '2026-11-18') todayEntry = saved.data.entry;
    }

    const beforeWater = await ada.request('/api/analytics?asOf=2026-11-18');
    assert.equal(beforeWater.status, 200);
    const day = beforeWater.data.periods.day;
    assert.equal(day.overall.calories.current.total, 2150);
    assert.equal(day.overall.calories.previous.total, 1950);
    assert.equal(day.overall.calories.current.percent, 97.7);
    assert.equal(day.overall.calories.previous.percent, 88.6);
    assert.equal(day.overall.calories.current.status, 'achieved');
    assert.equal(day.overall.calories.previous.status, 'below');
    assert.equal(day.overall.calories.totalDelta, 200);
    assert.equal(day.overall.charts.calories.series[0].values[0], 1950);
    assert.equal(day.overall.charts.calories.series[0].values[1], 2150);
    assert.equal(beforeWater.data.nutrients.water.today.total, null);
    assert.match(day.overall.summary, /2,150 kcal/);
    assert.match(day.overall.summary, /1,950 kcal/);
    assert.equal(/\bimproved\b|\bbetter\b|\bworse\b/i.test(day.overall.summary), false);

    const protein = beforeWater.data.nutrients.protein;
    assert.equal(protein.today.total, 90);
    assert.equal(protein.today.status, 'achieved');
    assert.equal(protein.yesterday.total, 90);
    assert.equal(protein.yesterday.status, 'below');
    assert.equal(protein.yesterday.goal.amount, 100);
    assert.equal(protein.today.goal.amount, 80);

    const salt = beforeWater.data.nutrients.salt;
    assert.equal(salt.today.total, 7);
    assert.equal(salt.today.status, 'exceeding');
    assert.equal(salt.today.percent, 116.7);
    assert.equal(day.nutrients.salt.current.evaluation, undefined);
    assert.equal(beforeWater.data.periods.day.nutrients.salt.summary.includes('not counted as a success'), true);
    assert.equal(salt.yesterday.total, 2);
    assert.equal(salt.yesterday.status, 'within');

    assert.equal(beforeWater.data.nutrients.unsaturated_fat.today.total, null);
    assert.equal(beforeWater.data.nutrients.unsaturated_fat.today.status, 'insufficient');
    assert.equal(beforeWater.data.nutrients.unsaturated_fat.components[0].today.total, 5);
    assert.equal(beforeWater.data.nutrients.unsaturated_fat.components[1].today.total, 2);
    assert.notEqual(
      (beforeWater.data.nutrients.unsaturated_fat.components[0].today.total || 0)
        + (beforeWater.data.nutrients.unsaturated_fat.components[1].today.total || 0),
      beforeWater.data.nutrients.unsaturated_fat.today.total,
    );
    assert.equal(beforeWater.data.nutrients.sugars.today.total, 35);
    assert.equal(beforeWater.data.nutrients.sugars.components[0].today.total, 8);
    assert.equal(beforeWater.data.nutrients.saturated_fat.today.status, 'exceeding');
    assert.equal(beforeWater.data.nutrients.fibre.today.status, 'below');

    const week = beforeWater.data.periods.week;
    assert.equal(week.overall.calories.current.total, 5900);
    assert.equal(week.overall.calories.previous.total, 6000);
    assert.equal(week.overall.calories.current.average, roundAmount(5900 / 3));
    assert.equal(week.overall.logged.current, 3);
    assert.equal(week.nutrients.salt.current.average, 4.5);
    assert.equal(week.nutrients.salt.current.coveredDays, 2);
    assert.equal(week.nutrients.salt.current.loggedDays, 3);
    assert.equal(week.nutrients.salt.current.achievedDays, 1);
    assert.equal(week.nutrients.salt.current.evaluatedDays, 2);
    assert.equal(week.nutrients.protein.current.achievedDays, 2);
    assert.deepEqual(week.overall.charts.calories.series.find((series) => series.id === 'current').values, [1800, 1950, 2150]);
    assert.deepEqual(week.overall.charts.calories.series.find((series) => series.id === 'previous').values, [2100, 2000, 1900]);

    const month = beforeWater.data.periods.month;
    assert.equal(month.overall.calories.previous.total, null);
    assert.equal(month.overall.calories.current.coveredDays, 6);
    assert.equal(month.overall.calories.current.calendarDays, 18);
    assert.equal(beforeWater.data.periods.year.previous.overall ? beforeWater.data.periods.year.overall.calories.previous.total : null, null);
    assert.equal(beforeWater.data.periods.year.overall.calories.current.average, roundAmount(11900 / 6));
    assert.equal(protein.extremes.highest.amount, 110);
    assert.equal(protein.extremes.highest.date, '2026-11-16');
    assert.equal(protein.extremes.lowest.date, '2026-11-11');

    const foodCount = app.db.prepare('SELECT COUNT(*) AS count FROM food_entries WHERE user_id = ?').get(
      app.db.prepare('SELECT id FROM users WHERE email = ?').get('analytics.ada@example.com').id,
    ).count;
    const firstGlass = await ada.request('/api/water', { method: 'POST', body: { date: '2026-11-18', amountMl: 250 } });
    const secondGlass = await ada.request('/api/water', { method: 'POST', body: { date: '2026-11-18', amountMl: 500 } });
    assert.equal(firstGlass.status, 201);
    assert.equal(secondGlass.status, 201);
    let withWater = await ada.request('/api/analytics?asOf=2026-11-18');
    assert.equal(withWater.data.nutrients.water.today.total, 750);
    assert.equal(withWater.data.nutrients.water.today.status, 'below');
    assert.equal(withWater.data.nutrients.water.today.percent, 37.5);
    assert.equal(withWater.data.periods.day.overall.calories.current.total, 2150);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM food_entries WHERE user_id = ?').get(
      app.db.prepare('SELECT id FROM users WHERE email = ?').get('analytics.ada@example.com').id,
    ).count, foodCount);

    const editedGlass = await ada.request(`/api/water/${secondGlass.data.entry.id}`, { method: 'PATCH', body: { amountMl: 300 } });
    assert.equal(editedGlass.status, 200);
    withWater = await ada.request('/api/analytics?asOf=2026-11-18');
    assert.equal(withWater.data.nutrients.water.today.total, 550);
    const removedGlass = await ada.request(`/api/water/${firstGlass.data.entry.id}`, { method: 'DELETE' });
    assert.equal(removedGlass.status, 200);
    withWater = await ada.request('/api/analytics?asOf=2026-11-18');
    assert.equal(withWater.data.nutrients.water.today.total, 300);

    await ben.request('/api/entries', { method: 'POST', body: manualBody('2026-11-18', 'Ben snack', 'ben-snack', { calories: 50, protein: 2, salt: 0.1 }) });
    await ben.request('/api/water', { method: 'POST', body: { date: '2026-11-18', amountMl: 100 } });
    const benReport = await ben.request('/api/analytics?asOf=2026-11-18');
    assert.equal(benReport.data.periods.day.overall.calories.current.total, 50);
    assert.equal(benReport.data.nutrients.water.today.total, 100);
    assert.equal(benReport.data.nutrients.protein.today.total, 2);
    const stolen = await ben.request(`/api/water/${editedGlass.data.entry.id}`, { method: 'DELETE' });
    assert.equal(stolen.status, 404);
    assert.equal((await ada.request('/api/analytics?asOf=2026-11-18')).data.nutrients.water.today.total, 300);

    const doubled = await ada.request(`/api/entries/${todayEntry.id}`, { method: 'PATCH', body: { quantity: 2, quantityUnit: 'product' } });
    assert.equal(doubled.status, 200);
    let afterEdit = await ada.request('/api/analytics?asOf=2026-11-18');
    assert.equal(afterEdit.data.periods.day.overall.calories.current.total, 4300);
    assert.equal(afterEdit.data.nutrients.protein.today.total, 180);
    assert.equal(afterEdit.data.nutrients.salt.today.total, 14);
    assert.equal(afterEdit.data.nutrients.unsaturated_fat.today.total, null);
    assert.equal(afterEdit.data.nutrients.unsaturated_fat.components[0].today.total, 10);
    assert.equal(afterEdit.data.periods.day.overall.calories.previous.total, 1950);

    const removed = await ada.request(`/api/entries/${todayEntry.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    afterEdit = await ada.request('/api/analytics?asOf=2026-11-18');
    assert.equal(afterEdit.data.periods.day.overall.calories.current.total, null);
    assert.equal(afterEdit.data.periods.day.overall.calories.current.status, 'unlogged');
    assert.equal(afterEdit.data.nutrients.salt.today.total, null);
    assert.equal(afterEdit.data.nutrients.water.today.total, 300);
    assert.equal(afterEdit.data.periods.day.overall.calories.previous.total, 1950);

    const bulkId = app.db.prepare('SELECT id FROM users WHERE email = ?').get('analytics.bulk@example.com').id;
    const insertEntry = app.db.prepare(`
      INSERT INTO food_entries (
        id, user_id, entry_date, consumed_at, name, quantity, quantity_unit, calories_kcal,
        snapshot_json, consumed_json, provenance_json, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertNutrient = app.db.prepare(`
      INSERT INTO food_entry_nutrients (entry_id, nutrient_key, amount, unit, label)
      VALUES (?, ?, ?, ?, ?)
    `);
    const start = shiftDate('2026-11-18', -2554);
    app.db.exec('BEGIN IMMEDIATE');
    let cursor = start;
    for (let index = 0; index < 2555; index += 1) {
      const id = `bulk-${cursor}`;
      const calories = cursor === start ? 999 : 100;
      const proteinAmount = cursor === '2020-06-15' ? 0 : cursor === start ? 50 : 10;
      insertEntry.run(
        id,
        bulkId,
        cursor,
        `${cursor}T12:00:00.000Z`,
        'History meal',
        1,
        'product',
        calories,
        '{}',
        '{}',
        '{}',
        `bulk-${cursor}`,
        `${cursor}T12:00:00.000Z`,
        `${cursor}T12:00:00.000Z`,
      );
      insertNutrient.run(id, 'calories', calories, 'kcal', 'Calories');
      insertNutrient.run(id, 'protein', proteinAmount, 'g', 'Protein');
      cursor = shiftDate(cursor, 1);
    }
    app.db.exec('COMMIT');
    assert.equal(cursor, '2026-11-19');

    const started = Date.now();
    const history = await bulk.request('/api/analytics?asOf=2026-11-18');
    const elapsed = Date.now() - started;
    assert.equal(history.status, 200);
    assert.ok(elapsed < 1500, `seven-year analytics took ${elapsed}ms`);
    assert.equal(history.data.nutrients.protein.extremes.highest.amount, 50);
    assert.equal(history.data.nutrients.protein.extremes.highest.date, start);
    assert.equal(history.data.nutrients.protein.extremes.lowest.amount, 0);
    assert.equal(history.data.nutrients.protein.extremes.lowest.date, '2020-06-15');
    assert.equal(history.data.nutrients.salt.today.total, null);
    assert.equal(history.data.nutrients.salt.today.status, 'insufficient');
    assert.equal(history.data.periods.year.overall.calories.current.average, 100);
    assert.equal(history.data.periods.year.overall.calories.current.coveredDays, inclusiveDays('2026-01-01', '2026-11-18').length);
    assert.equal(history.data.periods.day.overall.calories.current.total, 100);

    const deletedHistory = await bulk.request('/api/entries/bulk-2026-11-18', { method: 'DELETE' });
    assert.equal(deletedHistory.status, 200);
    const afterDelete = await bulk.request('/api/analytics?asOf=2026-11-18');
    assert.equal(afterDelete.data.periods.day.overall.calories.current.total, null);
    assert.equal(afterDelete.data.nutrients.protein.extremes.highest.amount, 50);
    assert.equal((await ada.request('/api/analytics?asOf=2026-11-18')).data.nutrients.protein.extremes.highest.amount, 110);
  } finally {
    server.close();
    app.close();
  }
});
