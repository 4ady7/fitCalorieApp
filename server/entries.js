import { randomUUID } from 'node:crypto';
import { GOAL_PROFILES, profileFor } from '../shared/goals.js';
import {
  NUTRIENT_DEFS,
  assertDate,
  basisFromType,
  consumedFromSnapshot,
  roundAmount,
  sanitizeBasis,
  sanitizeExtras,
  sanitizeGoals,
  sanitizeNutrientMap,
  sumExtras,
  sumNutrientMaps,
  todayISO,
} from '../shared/nutrients.js';
import {
  consumedFromNutrientRows,
  entryNutrients,
  writeEntryNutrients,
  writeProduct,
} from './catalog.js';
import { transaction } from './db.js';
import { HttpError } from './errors.js';
import { readReview } from './sign.js';

function bad(error) {
  if (error instanceof HttpError) throw error;
  throw new HttpError(400, error.message);
}

function parseDate(value) {
  try {
    return assertDate(value);
  } catch (error) {
    bad(error);
  }
}

function cleanName(name) {
  const value = String(name || '').trim().replace(/\s+/g, ' ');
  if (!value || value.length > 160) throw new HttpError(400, 'Enter a food name of up to 160 characters.', 'BAD_NAME');
  return value;
}

function parseKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
    throw new HttpError(400, 'The request was missing a valid idempotency key.', 'BAD_IDEMPOTENCY_KEY');
  }
  return key;
}

function presentEntry(row, nutrientRows) {
  const relational = consumedFromNutrientRows(nutrientRows);
  const consumed = relational || JSON.parse(row.consumed_json);
  return {
    id: row.id,
    productId: row.product_id || null,
    date: row.entry_date,
    consumedAt: row.consumed_at,
    name: row.name,
    quantity: row.quantity,
    quantityUnit: row.quantity_unit,
    servingAmount: row.serving_amount,
    servingUnit: row.serving_unit,
    servingLabel: row.serving_label,
    calories: consumed.nutrients.calories,
    nutrients: consumed.nutrients,
    extras: consumed.extras,
    snapshot: JSON.parse(row.snapshot_json),
    provenance: JSON.parse(row.provenance_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listEntries(db, userId, date) {
  const rows = db.prepare(`
    SELECT * FROM food_entries
    WHERE user_id = ? AND entry_date = ?
    ORDER BY created_at ASC, id ASC
  `).all(userId, date);
  const nutrients = entryNutrients(db, rows.map((row) => row.id));
  return rows.map((row) => presentEntry(row, nutrients.get(row.id)));
}

const COLUMN_KEYS = ['calories', 'protein', 'carbohydrates', 'fat', 'fibre'];

function emptyGoals() {
  return { ...sanitizeGoals({}), water: null };
}

function specFromTarget(target) {
  const profile = profileFor(target.nutrient_key);
  const kind = profile.allowed.includes(target.kind) ? target.kind : profile.kind;
  if (kind === 'range') {
    if (!(target.min_amount > 0) || !(target.max_amount > 0) || target.min_amount > target.max_amount) return null;
    return { kind, amount: null, min: target.min_amount, max: target.max_amount };
  }
  if (!(target.amount > 0)) return null;
  return { kind, amount: target.amount, min: null, max: null };
}

function flatFromDetails(details) {
  const goals = emptyGoals();
  for (const [key, spec] of Object.entries(details)) {
    if (!(key in goals) && key !== 'water') continue;
    goals[key] = spec.kind === 'range' ? null : spec.amount;
  }
  return goals;
}

function goalRecordFromRow(db, row) {
  if (!row) return { goals: emptyGoals(), details: {} };
  const details = {};
  for (const key of COLUMN_KEYS) {
    if (row[key] != null) {
      const profile = profileFor(key);
      details[key] = { kind: profile.kind, amount: row[key], min: null, max: null };
    }
  }
  const targets = db.prepare(`
    SELECT nutrient_key, amount, kind, min_amount, max_amount
    FROM goal_nutrient_targets
    WHERE goal_id = ?
  `).all(row.id);
  for (const target of targets) {
    const spec = specFromTarget(target);
    if (spec) details[target.nutrient_key] = spec;
    else delete details[target.nutrient_key];
  }
  return { goals: flatFromDetails(details), details };
}

function goalRow(db, userId, date) {
  return db.prepare(`
    SELECT * FROM daily_goals
    WHERE user_id = ? AND effective_date <= ?
    ORDER BY effective_date DESC
    LIMIT 1
  `).get(userId, date);
}

export function getGoals(db, userId, date = todayISO()) {
  return goalRecordFromRow(db, goalRow(db, userId, date)).goals;
}

export function getGoalRecord(db, userId, date = todayISO()) {
  return goalRecordFromRow(db, goalRow(db, userId, date));
}

export function listGoalHistory(db, userId) {
  return db.prepare(`
    SELECT * FROM daily_goals
    WHERE user_id = ?
    ORDER BY effective_date ASC
  `).all(userId).map((row) => ({
    effectiveDate: row.effective_date,
    details: goalRecordFromRow(db, row).details,
  }));
}

function finiteAmount(value, label) {
  if (value == null || value === '') return null;
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${label} must be greater than zero, or left empty.`);
  }
  if (amount > 1000000) throw new Error(`${label} is too large.`);
  return roundAmount(amount);
}

function normalizeSpec(key, amount, raw) {
  const profile = GOAL_PROFILES[key] || profileFor(key);
  const label = profile.label || key;
  const requested = raw && typeof raw === 'object' ? raw.kind : null;
  const kind = profile.allowed?.includes(requested) ? requested : profile.kind;
  if (kind === 'range') {
    const min = finiteAmount(raw?.min, `${label} minimum`);
    const max = finiteAmount(raw?.max, `${label} maximum`);
    if (min == null && max == null) return null;
    if (min == null || max == null || min > max) {
      throw new Error(`${label} range needs a minimum and a maximum, with the minimum first.`);
    }
    return { kind: 'range', amount: null, min, max };
  }
  const chosen = raw && typeof raw === 'object' && raw.amount != null ? finiteAmount(raw.amount, label) : amount;
  if (chosen == null) return null;
  return { kind, amount: chosen, min: null, max: null };
}

export function saveGoals(db, userId, input) {
  const source = input && typeof input === 'object' ? { ...input } : {};
  const requestedDate = source.effectiveDate;
  const specs = source.specs && typeof source.specs === 'object' ? source.specs : {};
  const waterRaw = source.water;
  delete source.effectiveDate;
  delete source.userId;
  delete source.specs;
  delete source.water;
  let targets;
  let effectiveDate = todayISO();
  let details;
  try {
    if (requestedDate != null) effectiveDate = assertDate(requestedDate);
    targets = sanitizeGoals(source);
    details = {};
    for (const def of NUTRIENT_DEFS) {
      const spec = normalizeSpec(def.key, targets[def.key], specs[def.key]);
      if (spec) details[def.key] = spec;
    }
    const waterAmount = waterRaw == null || waterRaw === '' ? null : finiteAmount(waterRaw, 'Water');
    const waterSpec = normalizeSpec('water', waterAmount, specs.water);
    if (waterSpec) details.water = waterSpec;
  } catch (error) {
    bad(error);
  }
  const column = (key) => (details[key] && details[key].kind !== 'range' ? details[key].amount : null);
  const now = new Date().toISOString();
  const id = randomUUID();
  transaction(db, () => {
    db.prepare(`
      INSERT INTO daily_goals (
        id, user_id, effective_date, calories, protein, carbohydrates, fat, fibre, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, effective_date) DO UPDATE SET
        calories = excluded.calories,
        protein = excluded.protein,
        carbohydrates = excluded.carbohydrates,
        fat = excluded.fat,
        fibre = excluded.fibre,
        updated_at = excluded.updated_at
    `).run(
      id,
      userId,
      effectiveDate,
      column('calories'),
      column('protein'),
      column('carbohydrates'),
      column('fat'),
      column('fibre'),
      now,
      now,
    );
    const saved = db.prepare('SELECT id FROM daily_goals WHERE user_id = ? AND effective_date = ?').get(userId, effectiveDate);
    db.prepare('DELETE FROM goal_nutrient_targets WHERE goal_id = ?').run(saved.id);
    const insert = db.prepare(`
      INSERT INTO goal_nutrient_targets (goal_id, nutrient_key, amount, kind, min_amount, max_amount)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [key, spec] of Object.entries(details)) {
      insert.run(saved.id, key, spec.amount, spec.kind, spec.min, spec.max);
    }
  });
  return { goals: flatFromDetails(details), details };
}

export function listHistory(db, userId) {
  return db.prepare(`
    SELECT entry_date AS date, COUNT(*) AS entryCount, SUM(calories_kcal) AS calories
    FROM food_entries
    WHERE user_id = ?
    GROUP BY entry_date
    ORDER BY entry_date DESC
    LIMIT 90
  `).all(userId).map((row) => ({
    date: row.date,
    entryCount: row.entryCount,
    calories: row.calories,
  }));
}

export function dayPayload(db, userId, date) {
  const entries = listEntries(db, userId, parseDate(date));
  const goalRecord = getGoalRecord(db, userId, parseDate(date));
  return {
    date,
    entries,
    totals: sumNutrientMaps(entries.map((entry) => entry.nutrients)),
    extras: sumExtras(entries.map((entry) => entry.extras)),
    goals: goalRecord.goals,
    goalDetails: goalRecord.details,
    history: listHistory(db, userId),
    entryCount: entries.length,
  };
}

function storedCalories(consumed) {
  const calories = consumed?.nutrients?.calories?.amount;
  return calories == null ? null : calories;
}

function guardCalories(consumed) {
  const calories = storedCalories(consumed);
  if (calories != null && calories > 20000) {
    throw new HttpError(400, 'That quantity produces an unrealistic calorie total. Check the amount.', 'CALORIES_TOO_HIGH');
  }
  return consumed;
}

function consume(snapshot, quantity, quantityUnit) {
  try {
    return guardCalories(consumedFromSnapshot(snapshot, quantity, quantityUnit));
  } catch (error) {
    bad(error);
  }
}

function consumedAtFor(date) {
  if (date === todayISO()) return new Date().toISOString();
  return `${date}T12:00:00.000Z`;
}

function insertRow(db, { userId, date, name, quantity, quantityUnit, snapshot, consumed, provenance, idempotencyKey }) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const write = () => {
    const existing = db.prepare('SELECT * FROM food_entries WHERE user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey);
    if (existing) return { duplicate: true, row: existing };
    const catalog = writeProduct(db, {
      name,
      brand: null,
      description: null,
      basis: snapshot.basis,
      nutrients: snapshot.nutrients,
      extras: snapshot.extras,
      serving: snapshot.serving,
      provenance,
    });
    db.prepare(`
      INSERT INTO food_entries (
        id, user_id, product_id, entry_date, consumed_at, name, quantity, quantity_unit,
        serving_amount, serving_unit, serving_label, calories_kcal,
        snapshot_json, consumed_json, provenance_json, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      catalog?.catalogId || null,
      date,
      consumedAtFor(date),
      name,
      quantity,
      quantityUnit,
      snapshot.serving?.amount ?? null,
      snapshot.serving?.unit ?? null,
      snapshot.serving?.label ?? null,
      storedCalories(consumed),
      JSON.stringify(snapshot),
      JSON.stringify({ nutrients: consumed.nutrients, extras: consumed.extras }),
      JSON.stringify(provenance),
      idempotencyKey,
      now,
      now,
    );
    writeEntryNutrients(db, id, consumed);
    return { duplicate: false, row: db.prepare('SELECT * FROM food_entries WHERE id = ? AND user_id = ?').get(id, userId) };
  };
  try {
    return transaction(db, write);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      const existing = db.prepare('SELECT * FROM food_entries WHERE user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey);
      if (existing) return { duplicate: true, row: existing };
    }
    throw error;
  }
}

function snapshotFromProduct(product, basisType) {
  if (!product || typeof product !== 'object') {
    throw new HttpError(400, 'The product preview is invalid. Look the product up again.', 'BAD_REVIEW');
  }
  const provider = product.provenance?.provider;
  if (!['openfoodfacts', 'page_structured', 'ai'].includes(provider)) {
    throw new HttpError(400, 'The product preview is invalid. Look the product up again.', 'BAD_REVIEW');
  }
  let nutrients;
  let extras;
  try {
    nutrients = sanitizeNutrientMap(product.nutrients);
    extras = sanitizeExtras(product.extras || []);
  } catch (error) {
    bad(error);
  }
  let basis = null;
  if (product.basis) {
    try {
      basis = sanitizeBasis(product.basis);
    } catch (error) {
      bad(error);
    }
  } else if (Array.isArray(product.basisOptions) && product.basisOptions.includes(basisType)) {
    try {
      basis = basisFromType(basisType);
    } catch (error) {
      bad(error);
    }
  } else {
    throw new HttpError(400, 'Choose whether these values are per 100 g, per 100 ml, per serving, or per product.', 'BASIS_REQUIRED');
  }
  let serving = null;
  if (product.serving && typeof product.serving === 'object') {
    const amount = product.serving.amount;
    const unit = product.serving.unit;
    if (typeof amount === 'number' && amount > 0 && ['g', 'ml', 'serving', 'product'].includes(unit)) {
      let servingNutrients = null;
      let servingExtras = [];
      if (product.serving.nutrients) {
        try {
          servingNutrients = sanitizeNutrientMap(product.serving.nutrients);
          servingExtras = sanitizeExtras(product.serving.extras || []);
        } catch (error) {
          bad(error);
        }
      }
      serving = {
        amount,
        unit,
        label: String(product.serving.label || '1 serving').slice(0, 80),
        nutrients: servingNutrients,
        extras: servingExtras,
      };
    }
  }
  return {
    name: cleanName(product.name),
    snapshot: { basis, nutrients, extras, serving },
    provenance: {
      provider,
      reference: String(product.provenance.reference || '').slice(0, 500),
      confidence: product.provenance.confidence === 'verified' ? 'verified' : 'extracted',
      retrievedAt: new Date().toISOString(),
      notes: Array.isArray(product.provenance.notes)
        ? product.provenance.notes.slice(0, 12).map((note) => String(note).slice(0, 280))
        : [],
    },
  };
}

function manualSnapshot(body) {
  const quantity = body.quantity;
  const quantityUnit = body.quantityUnit;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
    throw new HttpError(400, 'Enter a quantity greater than zero.', 'BAD_QUANTITY');
  }
  let nutrients;
  try {
    nutrients = sanitizeNutrientMap(body.nutrients || {});
  } catch (error) {
    bad(error);
  }
  const basisType = body.basisType;
  let basis;
  try {
    if (basisType === 'portion') {
      if (!['g', 'ml', 'serving', 'product'].includes(quantityUnit)) {
        throw new Error('Choose grams, millilitres, servings, or products.');
      }
      basis = basisFromType('per_amount', quantity, quantityUnit);
    } else if (basisType === 'per_100g') {
      if (quantityUnit !== 'g') throw new Error('Per 100 g values need a quantity in grams.');
      basis = basisFromType('per_100g');
    } else if (basisType === 'per_100ml') {
      if (quantityUnit !== 'ml') throw new Error('Per 100 ml values need a quantity in millilitres.');
      basis = basisFromType('per_100ml');
    } else if (basisType === 'per_serving') {
      if (quantityUnit !== 'serving') throw new Error('Per serving values need a quantity in servings.');
      basis = basisFromType('per_serving');
    } else {
      throw new Error('Choose what these nutrition values apply to.');
    }
  } catch (error) {
    bad(error);
  }
  return {
    name: cleanName(body.name),
    quantity,
    quantityUnit,
    snapshot: { basis, nutrients, extras: [], serving: null },
    provenance: {
      provider: 'manual',
      reference: 'user',
      confidence: 'user_entered',
      retrievedAt: new Date().toISOString(),
      notes: ['Entered by you.'],
    },
  };
}

export function addEntry(db, userId, secret, body) {
  const date = parseDate(body?.date);
  const idempotencyKey = parseKey(body?.idempotencyKey);
  let name;
  let quantity;
  let quantityUnit;
  let snapshot;
  let provenance;
  if (body?.reviewToken) {
    const product = readReview(body.reviewToken, secret, userId);
    const built = snapshotFromProduct(product, body.basisType);
    quantity = body.quantity;
    quantityUnit = body.quantityUnit;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpError(400, 'Enter a quantity greater than zero.', 'BAD_QUANTITY');
    }
    name = built.name;
    snapshot = built.snapshot;
    provenance = built.provenance;
  } else if (body?.source === 'manual') {
    const built = manualSnapshot(body);
    name = built.name;
    quantity = built.quantity;
    quantityUnit = built.quantityUnit;
    snapshot = built.snapshot;
    provenance = built.provenance;
  } else {
    throw new HttpError(400, 'Add a reviewed product or enter the food manually.', 'BAD_ENTRY');
  }
  const consumed = consume(snapshot, quantity, quantityUnit);
  const saved = insertRow(db, { userId, date, name, quantity, quantityUnit, snapshot, consumed, provenance, idempotencyKey });
  const nutrients = db.prepare('SELECT * FROM food_entry_nutrients WHERE entry_id = ?').all(saved.row.id);
  return {
    duplicate: saved.duplicate,
    entry: presentEntry(saved.row, nutrients),
    day: dayPayload(db, userId, saved.row.entry_date),
  };
}

export function updateEntry(db, userId, entryId, body) {
  const row = db.prepare('SELECT * FROM food_entries WHERE id = ? AND user_id = ?').get(entryId, userId);
  if (!row) throw new HttpError(404, 'That food entry was not found.', 'NOT_FOUND');
  const snapshot = JSON.parse(row.snapshot_json);
  const name = body?.name == null ? row.name : cleanName(body.name);
  const quantity = body?.quantity == null ? row.quantity : body.quantity;
  const quantityUnit = body?.quantityUnit == null ? row.quantity_unit : body.quantityUnit;
  const consumed = consume(snapshot, quantity, quantityUnit);
  const now = new Date().toISOString();
  transaction(db, () => {
    const result = db.prepare(`
      UPDATE food_entries
      SET name = ?, quantity = ?, quantity_unit = ?, calories_kcal = ?, consumed_json = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      name,
      quantity,
      quantityUnit,
      storedCalories(consumed),
      JSON.stringify({ nutrients: consumed.nutrients, extras: consumed.extras }),
      now,
      entryId,
      userId,
    );
    if (typeof result.changes === 'number' && result.changes !== 1) {
      throw new HttpError(404, 'That food entry was not found.', 'NOT_FOUND');
    }
    writeEntryNutrients(db, entryId, consumed);
  });
  return dayPayload(db, userId, row.entry_date);
}

export function deleteEntry(db, userId, entryId) {
  const row = db.prepare('SELECT entry_date FROM food_entries WHERE id = ? AND user_id = ?').get(entryId, userId);
  if (!row) throw new HttpError(404, 'That food entry was not found.', 'NOT_FOUND');
  db.prepare('DELETE FROM food_entries WHERE id = ? AND user_id = ?').run(entryId, userId);
  return dayPayload(db, userId, row.entry_date);
}
