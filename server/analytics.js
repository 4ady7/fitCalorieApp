import { buildAnalytics } from '../shared/analytics.js';
import { assertDate, todayISO } from '../shared/nutrients.js';
import { listGoalHistory } from './entries.js';
import { HttpError } from './errors.js';
import { listWater } from './water.js';

const FOOD_KEYS = [
  'calories',
  'protein',
  'carbohydrates',
  'fat',
  'fibre',
  'sugars',
  'added_sugars',
  'salt',
  'saturated_fat',
  'unsaturated_fat',
  'monounsaturated_fat',
  'polyunsaturated_fat',
];

/**
 * Aggregate in SQLite by user and date. Daily totals are not stored:
 * a food edit has to flow through the same sums as the first read.
 * The scan is indexed and small enough that a cache would mostly add
 * invalidation work whenever food, water, or goals change.
 */
function loadDays(db, userId) {
  const food = db.prepare(`
    SELECT entry_date AS date, COUNT(*) AS foodEntries
    FROM food_entries
    WHERE user_id = ?
    GROUP BY entry_date
  `).all(userId);
  const placeholders = FOOD_KEYS.map(() => '?').join(', ');
  const nutrients = db.prepare(`
    SELECT e.entry_date AS date,
           n.nutrient_key AS key,
           SUM(n.amount) AS amount,
           SUM(CASE WHEN n.amount IS NOT NULL THEN 1 ELSE 0 END) AS known
    FROM food_entry_nutrients n
    JOIN food_entries e ON e.id = n.entry_id
    WHERE e.user_id = ? AND n.nutrient_key IN (${placeholders})
    GROUP BY e.entry_date, n.nutrient_key
  `).all(userId, ...FOOD_KEYS);
  const water = db.prepare(`
    SELECT entry_date AS date, SUM(amount_ml) AS amount, COUNT(*) AS entries
    FROM water_entries
    WHERE user_id = ?
    GROUP BY entry_date
  `).all(userId);

  const byDate = new Map();
  const ensure = (date) => {
    let day = byDate.get(date);
    if (!day) {
      day = { date, foodEntries: 0, nutrients: {}, water: null };
      byDate.set(date, day);
    }
    return day;
  };
  for (const row of food) ensure(row.date).foodEntries = row.foodEntries;
  for (const row of nutrients) {
    if (!(row.known > 0) || row.amount == null) continue;
    ensure(row.date).nutrients[row.key] = { amount: row.amount, known: row.known };
  }
  for (const row of water) {
    if (!(row.entries > 0) || row.amount == null) continue;
    ensure(row.date).water = { amount: row.amount, entries: row.entries };
  }
  return [...byDate.values()];
}

export function analyticsPayload(db, userId, requestedDate) {
  let asOf = todayISO();
  if (requestedDate) {
    try {
      asOf = assertDate(requestedDate);
    } catch (error) {
      throw new HttpError(400, error.message, 'BAD_DATE');
    }
  }
  const report = buildAnalytics({
    asOf,
    days: loadDays(db, userId),
    goals: listGoalHistory(db, userId),
  });
  report.waterEntries = listWater(db, userId, asOf);
  return report;
}
