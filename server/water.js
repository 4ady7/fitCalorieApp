import { randomUUID } from 'node:crypto';
import { assertDate, roundAmount } from '../shared/nutrients.js';
import { HttpError } from './errors.js';

function parseDate(value) {
  try {
    return assertDate(value);
  } catch (error) {
    throw new HttpError(400, error.message, 'BAD_DATE');
  }
}

function parseAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10000) {
    throw new HttpError(400, 'Enter a water amount greater than 0 and up to 10,000 ml.', 'BAD_WATER');
  }
  return roundAmount(value, 1);
}

function present(row) {
  return {
    id: row.id,
    date: row.entry_date,
    amountMl: row.amount_ml,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWater(db, userId, date) {
  return db.prepare(`
    SELECT * FROM water_entries
    WHERE user_id = ? AND entry_date = ?
    ORDER BY created_at ASC, id ASC
  `).all(userId, parseDate(date)).map(present);
}

export function addWater(db, userId, body) {
  const date = parseDate(body?.date);
  const amount = parseAmount(body?.amountMl);
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO water_entries (id, user_id, entry_date, amount_ml, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, date, amount, now, now);
  const entry = db.prepare('SELECT * FROM water_entries WHERE id = ? AND user_id = ?').get(id, userId);
  return { entry: present(entry), entries: listWater(db, userId, date) };
}

export function updateWater(db, userId, id, body) {
  const existing = db.prepare('SELECT * FROM water_entries WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) throw new HttpError(404, 'That water entry was not found.', 'NOT_FOUND');
  const amount = body?.amountMl == null ? existing.amount_ml : parseAmount(body.amountMl);
  const date = body?.date == null ? existing.entry_date : parseDate(body.date);
  db.prepare(`
    UPDATE water_entries
    SET amount_ml = ?, entry_date = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(amount, date, new Date().toISOString(), id, userId);
  const entry = db.prepare('SELECT * FROM water_entries WHERE id = ? AND user_id = ?').get(id, userId);
  return { entry: present(entry), entries: listWater(db, userId, date) };
}

export function deleteWater(db, userId, id) {
  const existing = db.prepare('SELECT * FROM water_entries WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) throw new HttpError(404, 'That water entry was not found.', 'NOT_FOUND');
  db.prepare('DELETE FROM water_entries WHERE id = ? AND user_id = ?').run(id, userId);
  return { entries: listWater(db, userId, existing.entry_date) };
}
