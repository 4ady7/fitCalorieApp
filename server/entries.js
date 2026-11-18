import { randomUUID } from 'node:crypto';
import {
  assertDate,
  basisFromType,
  consumedFromSnapshot,
  sanitizeBasis,
  sanitizeExtras,
  sanitizeGoals,
  sanitizeNutrientMap,
  sumExtras,
  sumNutrientMaps,
} from '../shared/nutrients.js';
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

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
    throw error;
  }
}

function presentEntry(row) {
  const consumed = JSON.parse(row.consumed_json);
  return {
    id: row.id,
    date: row.entry_date,
    name: row.name,
    quantity: row.quantity,
    quantityUnit: row.quantity_unit,
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
  return db.prepare(`
    SELECT * FROM food_entries
    WHERE user_id = ? AND entry_date = ?
    ORDER BY created_at ASC, id ASC
  `).all(userId, date).map(presentEntry);
}

export function getGoals(db, userId) {
  const row = db.prepare('SELECT targets_json FROM goals WHERE user_id = ?').get(userId);
  if (!row) return sanitizeGoals({});
  return sanitizeGoals(JSON.parse(row.targets_json));
}

export function saveGoals(db, userId, input) {
  let targets;
  try {
    targets = sanitizeGoals(input);
  } catch (error) {
    bad(error);
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO goals (user_id, targets_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET targets_json = excluded.targets_json, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(targets), now);
  return targets;
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
  return {
    date,
    entries,
    totals: sumNutrientMaps(entries.map((entry) => entry.nutrients)),
    extras: sumExtras(entries.map((entry) => entry.extras)),
    goals: getGoals(db, userId),
    history: listHistory(db, userId),
    entryCount: entries.length,
  };
}

function guardCalories(consumed) {
  const calories = consumed?.nutrients?.calories?.amount;
  if (calories == null) throw new HttpError(400, 'Calories were not available, so this item cannot be added.', 'CALORIES_REQUIRED');
  if (calories > 20000) {
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

function insertRow(db, { userId, date, name, quantity, quantityUnit, snapshot, consumed, provenance, idempotencyKey }) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const write = () => {
    const existing = db.prepare('SELECT * FROM food_entries WHERE user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey);
    if (existing) return { duplicate: true, row: existing };
    db.prepare(`
      INSERT INTO food_entries (
        id, user_id, entry_date, name, quantity, quantity_unit, calories_kcal,
        snapshot_json, consumed_json, provenance_json, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      date,
      name,
      quantity,
      quantityUnit,
      consumed.nutrients.calories.amount,
      JSON.stringify(snapshot),
      JSON.stringify({ nutrients: consumed.nutrients, extras: consumed.extras }),
      JSON.stringify(provenance),
      idempotencyKey,
      now,
      now,
    );
    return { duplicate: false, row: db.prepare('SELECT * FROM food_entries WHERE id = ?').get(id) };
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
  return {
    duplicate: saved.duplicate,
    entry: presentEntry(saved.row),
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
  db.prepare(`
    UPDATE food_entries
    SET name = ?, quantity = ?, quantity_unit = ?, calories_kcal = ?, consumed_json = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    name,
    quantity,
    quantityUnit,
    consumed.nutrients.calories.amount,
    JSON.stringify({ nutrients: consumed.nutrients, extras: consumed.extras }),
    now,
    entryId,
    userId,
  );
  return dayPayload(db, userId, row.entry_date);
}

export function deleteEntry(db, userId, entryId) {
  const row = db.prepare('SELECT entry_date FROM food_entries WHERE id = ? AND user_id = ?').get(entryId, userId);
  if (!row) throw new HttpError(404, 'That food entry was not found.', 'NOT_FOUND');
  db.prepare('DELETE FROM food_entries WHERE id = ? AND user_id = ?').run(entryId, userId);
  return dayPayload(db, userId, row.entry_date);
}
