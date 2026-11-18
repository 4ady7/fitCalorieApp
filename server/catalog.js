import { randomUUID } from 'node:crypto';
import { NUTRIENT_DEFS, blankNutrients, nutrientDef } from '../shared/nutrients.js';
import { transaction } from './db.js';

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const SHARED_SOURCES = new Set(['openfoodfacts', 'page_structured', 'ai']);

function findRow(db, { barcode, source, sourceReference }) {
  if (barcode) {
    const byBarcode = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
    if (byBarcode) return byBarcode;
  }
  if (source && sourceReference) {
    return db.prepare('SELECT * FROM products WHERE source = ? AND source_reference = ?').get(source, sourceReference) || null;
  }
  return null;
}

export function productKey(product) {
  const source = product?.provenance?.provider || 'unknown';
  const sourceReference = String(product?.provenance?.reference || '').slice(0, 500);
  const barcode = source === 'openfoodfacts' ? sourceReference.replace(/\D/g, '') : '';
  return {
    source,
    sourceReference: sourceReference || null,
    barcode: barcode || null,
  };
}

function basisFields(basis, basisOptions) {
  if (!basis) {
    return {
      basis_type: 'unspecified',
      basis_amount: null,
      basis_unit: null,
      basis_label: null,
      basis_options_json: JSON.stringify(basisOptions || []),
    };
  }
  return {
    basis_type: basis.type,
    basis_amount: basis.referenceAmount,
    basis_unit: basis.referenceUnit,
    basis_label: basis.label,
    basis_options_json: null,
  };
}

function insertNutrient(db, productId, key, value, label, unit, basis, scope, source, confidence) {
  db.prepare(`
    INSERT INTO product_nutrients (
      product_id, nutrient_key, amount, unit, label, basis_type, reference_amount, reference_unit, scope, source, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId,
    key,
    value?.amount ?? null,
    unit,
    label,
    basis?.type || 'unspecified',
    basis?.referenceAmount ?? null,
    basis?.referenceUnit ?? null,
    scope,
    source,
    confidence,
  );
}

export function hydrateProduct(db, row) {
  const nutrientRows = db.prepare('SELECT * FROM product_nutrients WHERE product_id = ?').all(row.id);
  const nutrients = blankNutrients();
  const extras = [];
  const servingNutrients = blankNutrients();
  const servingExtras = [];
  let servingKnown = false;
  for (const item of nutrientRows) {
    const def = nutrientDef(item.nutrient_key);
    const value = item.amount == null ? null : { amount: item.amount, unit: item.unit };
    if (item.scope === 'serving') {
      servingKnown = true;
      if (def) servingNutrients[item.nutrient_key] = value;
      else if (value) servingExtras.push({ key: item.nutrient_key, label: item.label, unit: item.unit, amount: item.amount });
    } else if (def) {
      nutrients[item.nutrient_key] = value;
    } else if (value) {
      extras.push({ key: item.nutrient_key, label: item.label, unit: item.unit, amount: item.amount });
    }
  }
  const basis = row.basis_type && row.basis_type !== 'unspecified'
    ? {
        type: row.basis_type,
        referenceAmount: row.basis_amount,
        referenceUnit: row.basis_unit,
        label: row.basis_label,
      }
    : null;
  let serving = null;
  if (row.serving_amount > 0 && row.serving_unit) {
    serving = {
      amount: row.serving_amount,
      unit: row.serving_unit,
      label: row.serving_label || '1 serving',
      nutrients: servingKnown ? servingNutrients : null,
      extras: servingKnown ? servingExtras : [],
    };
  }
  return {
    catalogId: row.id,
    name: row.name,
    brand: row.brand,
    description: row.description,
    basis,
    nutrients,
    extras,
    serving,
    basisOptions: row.basis_options_json ? JSON.parse(row.basis_options_json) : null,
    provenance: {
      provider: row.source,
      reference: row.source_reference || '',
      confidence: row.confidence,
      retrievedAt: row.verified_at,
      notes: JSON.parse(row.notes_json || '[]'),
    },
  };
}

function writeProduct(db, product) {
  const key = productKey(product);
  if (!SHARED_SOURCES.has(key.source)) return null;
  const now = new Date().toISOString();
  const basis = basisFields(product.basis, product.basisOptions);
  const serving = product.serving && product.serving.amount > 0 ? product.serving : null;
  let row = findRow(db, key);
  if (!row) {
    const id = randomUUID();
    try {
      db.prepare(`
        INSERT INTO products (
          id, name, barcode, brand, description, serving_amount, serving_unit, serving_label,
          basis_type, basis_amount, basis_unit, basis_label, basis_options_json,
          source, source_reference, confidence, notes_json, verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        String(product.name || 'Unnamed product').slice(0, 160),
        key.barcode,
        product.brand || null,
        product.description || null,
        serving?.amount ?? null,
        serving?.unit ?? null,
        serving?.label ?? null,
        basis.basis_type,
        basis.basis_amount,
        basis.basis_unit,
        basis.basis_label,
        basis.basis_options_json,
        key.source,
        key.sourceReference,
        product.provenance?.confidence === 'verified' ? 'verified' : 'extracted',
        JSON.stringify(product.provenance?.notes || []),
        product.provenance?.retrievedAt || now,
        now,
        now,
      );
      row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
      row = findRow(db, key);
      if (!row) throw error;
    }
  }
  if (row) {
    db.prepare(`
      UPDATE products SET
        name = ?, barcode = COALESCE(?, barcode), brand = ?, description = ?,
        serving_amount = ?, serving_unit = ?, serving_label = ?,
        basis_type = ?, basis_amount = ?, basis_unit = ?, basis_label = ?, basis_options_json = ?,
        source = ?, source_reference = COALESCE(?, source_reference), confidence = ?, notes_json = ?,
        verified_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      String(product.name || row.name).slice(0, 160),
      key.barcode,
      product.brand || null,
      product.description || null,
      serving?.amount ?? null,
      serving?.unit ?? null,
      serving?.label ?? null,
      basis.basis_type,
      basis.basis_amount,
      basis.basis_unit,
      basis.basis_label,
      basis.basis_options_json,
      key.source,
      key.sourceReference,
      product.provenance?.confidence === 'verified' ? 'verified' : 'extracted',
      JSON.stringify(product.provenance?.notes || []),
      product.provenance?.retrievedAt || now,
      now,
      row.id,
    );
    row = db.prepare('SELECT * FROM products WHERE id = ?').get(row.id);
  }
  db.prepare('DELETE FROM product_nutrients WHERE product_id = ?').run(row.id);
  const source = key.source;
  const confidence = row.confidence;
  for (const def of NUTRIENT_DEFS) {
    insertNutrient(db, row.id, def.key, product.nutrients?.[def.key], def.label, def.unit, product.basis, 'reference', source, confidence);
  }
  for (const extra of product.extras || []) {
    insertNutrient(db, row.id, extra.key, extra, extra.label, extra.unit, product.basis, 'reference', source, confidence);
  }
  if (serving?.nutrients) {
    for (const def of NUTRIENT_DEFS) {
      insertNutrient(db, row.id, def.key, serving.nutrients[def.key], def.label, def.unit, product.basis, 'serving', source, confidence);
    }
    for (const extra of serving.extras || []) {
      insertNutrient(db, row.id, extra.key, extra, extra.label, extra.unit, product.basis, 'serving', source, confidence);
    }
  }
  return hydrateProduct(db, row);
}

export function rememberProduct(db, product) {
  return transaction(db, () => writeProduct(db, product));
}

export function freshProduct(db, { barcode, source, sourceReference } = {}) {
  const row = findRow(db, {
    barcode: barcode ? String(barcode).replace(/\D/g, '') : null,
    source,
    sourceReference,
  });
  if (!row?.verified_at) return null;
  const age = Date.now() - Date.parse(row.verified_at);
  if (!Number.isFinite(age) || age > FRESH_MS) return null;
  return hydrateProduct(db, row);
}

export function writeEntryNutrients(db, entryId, consumed) {
  db.prepare('DELETE FROM food_entry_nutrients WHERE entry_id = ?').run(entryId);
  const insert = db.prepare(`
    INSERT INTO food_entry_nutrients (entry_id, nutrient_key, amount, unit, label)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const def of NUTRIENT_DEFS) {
    const value = consumed.nutrients?.[def.key];
    insert.run(entryId, def.key, value?.amount ?? null, value?.unit || def.unit, def.label);
  }
  for (const extra of consumed.extras || []) {
    insert.run(entryId, extra.key, extra.amount, extra.unit, extra.label);
  }
}

export function entryNutrients(db, entryIds) {
  if (!entryIds.length) return new Map();
  const placeholders = entryIds.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM food_entry_nutrients WHERE entry_id IN (${placeholders})`).all(...entryIds);
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.entry_id) || [];
    list.push(row);
    grouped.set(row.entry_id, list);
  }
  return grouped;
}

export function consumedFromNutrientRows(rows) {
  if (!rows?.length) return null;
  const nutrients = blankNutrients();
  const extras = [];
  for (const row of rows) {
    const def = nutrientDef(row.nutrient_key);
    if (def) {
      nutrients[def.key] = row.amount == null ? null : { amount: row.amount, unit: def.unit };
    } else if (row.amount != null) {
      extras.push({ key: row.nutrient_key, label: row.label, unit: row.unit, amount: row.amount });
    }
  }
  return { nutrients, extras };
}

export function backfillStoredEntries(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'food_entries'`).get()) return;
  const rows = db.prepare('SELECT * FROM food_entries').all();
  transaction(db, () => {
    for (const row of rows) {
      const nutrientCount = db.prepare('SELECT COUNT(*) AS count FROM food_entry_nutrients WHERE entry_id = ?').get(row.id).count;
      let consumed;
      try { consumed = JSON.parse(row.consumed_json); } catch { consumed = null; }
      if (nutrientCount === 0 && consumed?.nutrients) {
        try { writeEntryNutrients(db, row.id, consumed); } catch (error) {
          console.error(`Could not store nutrients for entry ${row.id}:`, error.message);
        }
      }
      if (row.product_id) continue;
      let snapshot;
      let provenance;
      try {
        snapshot = JSON.parse(row.snapshot_json);
        provenance = JSON.parse(row.provenance_json);
      } catch {
        continue;
      }
      if (!SHARED_SOURCES.has(provenance?.provider) || !provenance.reference) continue;
      const saved = writeProduct(db, {
        name: row.name,
        brand: null,
        description: null,
        basis: snapshot.basis,
        nutrients: snapshot.nutrients,
        extras: snapshot.extras || [],
        serving: snapshot.serving,
        basisOptions: snapshot.basis ? null : ['per_100g', 'per_100ml', 'per_serving', 'per_product'],
        provenance,
      });
      if (!saved) continue;
      db.prepare(`
        UPDATE food_entries
        SET product_id = ?, serving_amount = ?, serving_unit = ?, serving_label = ?
        WHERE id = ? AND user_id = ?
      `).run(
        saved.catalogId,
        snapshot.serving?.amount ?? null,
        snapshot.serving?.unit ?? null,
        snapshot.serving?.label ?? null,
        row.id,
        row.user_id,
      );
    }
  });
}

export { writeProduct };
