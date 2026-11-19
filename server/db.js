import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NUTRIENT_DEFS } from '../shared/nutrients.js';

/**
 * One SQLite database for every account.
 * SQLite has no row-level security. Private rows are protected by foreign keys
 * and by queries that always bind the user id from the authenticated session.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  openai_api_key TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  barcode TEXT,
  brand TEXT,
  description TEXT,
  serving_amount REAL,
  serving_unit TEXT,
  serving_label TEXT,
  basis_type TEXT,
  basis_amount REAL,
  basis_unit TEXT,
  basis_label TEXT,
  basis_options_json TEXT,
  source TEXT NOT NULL,
  source_reference TEXT,
  confidence TEXT NOT NULL,
  notes_json TEXT NOT NULL DEFAULT '[]',
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_nutrients (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  nutrient_key TEXT NOT NULL,
  amount REAL CHECK (amount IS NULL OR (amount >= 0 AND amount <= 1000000)),
  unit TEXT NOT NULL,
  label TEXT NOT NULL,
  basis_type TEXT NOT NULL,
  reference_amount REAL,
  reference_unit TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('reference', 'serving')),
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  PRIMARY KEY (product_id, nutrient_key, scope)
);

CREATE TABLE IF NOT EXISTS daily_goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL,
  calories REAL CHECK (calories IS NULL OR calories > 0),
  protein REAL CHECK (protein IS NULL OR protein > 0),
  carbohydrates REAL CHECK (carbohydrates IS NULL OR carbohydrates > 0),
  fat REAL CHECK (fat IS NULL OR fat > 0),
  fibre REAL CHECK (fibre IS NULL OR fibre > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, effective_date)
);

CREATE TABLE IF NOT EXISTS goal_nutrient_targets (
  goal_id TEXT NOT NULL REFERENCES daily_goals(id) ON DELETE CASCADE,
  nutrient_key TEXT NOT NULL,
  amount REAL CHECK (amount IS NULL OR amount > 0),
  kind TEXT NOT NULL DEFAULT 'target' CHECK (kind IN ('minimum', 'maximum', 'target', 'range')),
  min_amount REAL CHECK (min_amount IS NULL OR min_amount > 0),
  max_amount REAL CHECK (max_amount IS NULL OR max_amount > 0),
  PRIMARY KEY (goal_id, nutrient_key)
);

CREATE TABLE IF NOT EXISTS water_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  amount_ml REAL NOT NULL CHECK (amount_ml > 0 AND amount_ml <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  entry_date TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  quantity_unit TEXT NOT NULL,
  serving_amount REAL,
  serving_unit TEXT,
  serving_label TEXT,
  calories_kcal REAL NOT NULL CHECK (calories_kcal >= 0),
  snapshot_json TEXT NOT NULL,
  consumed_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS food_entry_nutrients (
  entry_id TEXT NOT NULL REFERENCES food_entries(id) ON DELETE CASCADE,
  nutrient_key TEXT NOT NULL,
  amount REAL CHECK (amount IS NULL OR (amount >= 0 AND amount <= 1000000)),
  unit TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (entry_id, nutrient_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode
  ON products (barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_source
  ON products (source, source_reference) WHERE source_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON food_entries (user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user_date ON daily_goals (user_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_water_user_date ON water_entries (user_id, entry_date);
`;

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* report the original error */ }
    throw error;
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function columnSet(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumn(db, table, column, definition) {
  if (!tableExists(db, table)) return;
  if (columnSet(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function currentVersion(db) {
  if (!tableExists(db, 'schema_migrations')) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  return row?.version || 0;
}

function backfill(db) {
  addColumn(db, 'food_entries', 'product_id', 'TEXT REFERENCES products(id) ON DELETE SET NULL');
  addColumn(db, 'food_entries', 'consumed_at', 'TEXT');
  addColumn(db, 'food_entries', 'serving_amount', 'REAL');
  addColumn(db, 'food_entries', 'serving_unit', 'TEXT');
  addColumn(db, 'food_entries', 'serving_label', 'TEXT');
  if (tableExists(db, 'food_entries')) {
    db.prepare(`UPDATE food_entries SET consumed_at = created_at WHERE consumed_at IS NULL`).run();
    db.exec('CREATE INDEX IF NOT EXISTS idx_entries_product ON food_entries (product_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_entries_consumed ON food_entries (user_id, consumed_at)');
  }

  if (tableExists(db, 'goals') && tableExists(db, 'daily_goals')) {
    const legacy = db.prepare('SELECT user_id, targets_json, updated_at FROM goals').all();
    const insertGoal = db.prepare(`
      INSERT INTO daily_goals (
        id, user_id, effective_date, calories, protein, carbohydrates, fat, fibre, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, effective_date) DO NOTHING
    `);
    const insertTarget = db.prepare(`
      INSERT INTO goal_nutrient_targets (goal_id, nutrient_key, amount)
      VALUES (?, ?, ?)
      ON CONFLICT(goal_id, nutrient_key) DO NOTHING
    `);
    for (const row of legacy) {
      let targets = {};
      try { targets = JSON.parse(row.targets_json) || {}; } catch { targets = {}; }
      // The previous table stored one goal and applied it to every day.
      const effectiveDate = '1970-01-01';
      const id = `goal-${row.user_id}`;
      const positive = (value) => (typeof value === 'number' && value > 0 ? value : null);
      insertGoal.run(
        id,
        row.user_id,
        effectiveDate,
        positive(targets.calories),
        positive(targets.protein),
        positive(targets.carbohydrates),
        positive(targets.fat),
        positive(targets.fibre),
        row.updated_at,
        row.updated_at,
      );
      for (const def of NUTRIENT_DEFS) {
        const amount = positive(targets[def.key]);
        if (amount != null) insertTarget.run(id, def.key, amount);
      }
    }
  }
}

export function openDatabase(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(SCHEMA);
  if (currentVersion(db) < 1) {
    transaction(db, () => {
      backfill(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(new Date().toISOString());
    });
  }
  if (currentVersion(db) < 2) {
    transaction(db, () => {
      addColumn(db, 'users', 'openai_api_key', 'TEXT');
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(new Date().toISOString());
    });
  }
  if (currentVersion(db) < 3) {
    transaction(db, () => {
      addColumn(db, 'goal_nutrient_targets', 'kind', "TEXT NOT NULL DEFAULT 'target'");
      addColumn(db, 'goal_nutrient_targets', 'min_amount', 'REAL');
      addColumn(db, 'goal_nutrient_targets', 'max_amount', 'REAL');
      if (tableExists(db, 'goal_nutrient_targets')) {
        db.exec(`
          UPDATE goal_nutrient_targets SET kind = 'minimum'
          WHERE nutrient_key IN ('protein', 'fibre') AND kind = 'target' AND min_amount IS NULL;
          UPDATE goal_nutrient_targets SET kind = 'maximum'
          WHERE nutrient_key IN ('salt', 'sugars', 'added_sugars', 'saturated_fat') AND kind = 'target' AND min_amount IS NULL;
        `);
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_water_user_date ON water_entries (user_id, entry_date)');
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)').run(new Date().toISOString());
    });
  }
  return db;
}
