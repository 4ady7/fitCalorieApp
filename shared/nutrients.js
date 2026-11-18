/** Canonical nutrients. `null` means the source did not state a value. `0` is a real zero. */

export const NUTRIENT_DEFS = [
  { key: 'calories', label: 'Calories', unit: 'kcal', group: 'energy' },
  { key: 'protein', label: 'Protein', unit: 'g', group: 'macro' },
  { key: 'carbohydrates', label: 'Carbohydrates', unit: 'g', group: 'macro' },
  { key: 'fat', label: 'Total fat', unit: 'g', group: 'macro' },
  { key: 'saturated_fat', label: 'Saturated fat', unit: 'g', group: 'macro' },
  { key: 'fibre', label: 'Dietary fibre', unit: 'g', group: 'macro' },
  { key: 'sugars', label: 'Sugars', unit: 'g', group: 'macro' },
  { key: 'sodium', label: 'Sodium', unit: 'mg', group: 'micro' },
  { key: 'salt', label: 'Salt', unit: 'g', group: 'micro' },
  { key: 'potassium', label: 'Potassium', unit: 'mg', group: 'micro' },
  { key: 'calcium', label: 'Calcium', unit: 'mg', group: 'micro' },
  { key: 'iron', label: 'Iron', unit: 'mg', group: 'micro' },
  { key: 'magnesium', label: 'Magnesium', unit: 'mg', group: 'micro' },
  { key: 'zinc', label: 'Zinc', unit: 'mg', group: 'micro' },
  { key: 'vitamin_a', label: 'Vitamin A', unit: 'µg', group: 'micro' },
  { key: 'vitamin_c', label: 'Vitamin C', unit: 'mg', group: 'micro' },
  { key: 'vitamin_d', label: 'Vitamin D', unit: 'µg', group: 'micro' },
  { key: 'vitamin_e', label: 'Vitamin E', unit: 'mg', group: 'micro' },
  { key: 'vitamin_b12', label: 'Vitamin B12', unit: 'µg', group: 'micro' },
];

export const GOAL_KEYS = ['calories', 'protein', 'carbohydrates', 'fat', 'fibre'];

const MASS_IN_GRAMS = { g: 1, mg: 0.001, µg: 0.000001 };

export function blankNutrients() {
  return Object.fromEntries(NUTRIENT_DEFS.map((def) => [def.key, null]));
}

export function nutrientDef(key) {
  return NUTRIENT_DEFS.find((def) => def.key === key) || null;
}

export function canonicalUnit(unit) {
  const value = String(unit || '').trim().toLowerCase().replace('μ', 'µ');
  if (value === 'ug' || value === 'mcg' || value === 'µg') return 'µg';
  if (value === 'kj') return 'kJ';
  if (value === 'kcal' || value === 'calorie' || value === 'calories') return 'kcal';
  if (value === 'g' || value === 'gram' || value === 'grams') return 'g';
  if (value === 'mg') return 'mg';
  if (value === 'ml' || value === 'millilitre' || value === 'milliliter') return 'ml';
  if (value === 'l' || value === 'litre' || value === 'liter') return 'l';
  return null;
}

/** Convert a stated measurement into the unit we store. Returns null when the units are not comparable. */
export function convertUnit(amount, from, to) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const source = canonicalUnit(from);
  const target = canonicalUnit(to);
  if (!source || !target) return null;
  if (source === target) return amount;
  if (source === 'kJ' && target === 'kcal') return amount / 4.184;
  if (source === 'kcal' && target === 'kJ') return amount * 4.184;
  if (source === 'l' && target === 'ml') return amount * 1000;
  if (source === 'ml' && target === 'l') return amount / 1000;
  if (MASS_IN_GRAMS[source] && MASS_IN_GRAMS[target]) {
    return (amount * MASS_IN_GRAMS[source]) / MASS_IN_GRAMS[target];
  }
  return null;
}

export function roundAmount(amount, decimals = 4) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const factor = 10 ** decimals;
  return Math.round((amount + Number.EPSILON) * factor) / factor;
}

export function formatNumber(amount, unit) {
  if (amount == null || Number.isNaN(amount)) return null;
  const digits = unit === 'kcal' ? 1 : 3;
  const factor = 10 ** digits;
  const rounded = Math.round((amount + Number.EPSILON) * factor) / factor;
  const [whole, fraction] = String(rounded).split('.');
  const grouped = unit === 'kcal' ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function formatAmount(value) {
  if (value == null || value.amount == null) return null;
  const number = formatNumber(value.amount, value.unit);
  return number == null ? null : `${number} ${value.unit}`;
}

export function unavailableLabels(nutrients) {
  return NUTRIENT_DEFS.filter((def) => nutrients?.[def.key] == null).map((def) => def.label);
}

export function scaleMap(nutrients, factor) {
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) {
    throw new Error('The quantity could not be applied to these nutrition values.');
  }
  const out = blankNutrients();
  for (const def of NUTRIENT_DEFS) {
    const value = nutrients?.[def.key];
    if (value == null) continue;
    out[def.key] = {
      amount: roundAmount(value.amount * factor),
      unit: def.unit,
    };
  }
  return out;
}

export function scaleExtras(extras, factor) {
  if (!Array.isArray(extras) || extras.length === 0) return [];
  return extras.map((item) => ({
    key: item.key,
    label: item.label,
    unit: item.unit,
    amount: roundAmount(item.amount * factor),
  }));
}

export function servingAvailable(snapshot) {
  const serving = snapshot?.serving;
  if (!serving || !(serving.amount > 0)) return false;
  if (serving.nutrients?.calories) return true;
  return serving.unit === snapshot.basis?.referenceUnit;
}

/**
 * Scale reference nutrition to the amount eaten.
 * Missing nutrients stay null. Zero stays zero. Units are never mixed.
 */
export function consumedFromSnapshot(snapshot, quantity, quantityUnit) {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Enter a quantity greater than zero.');
  }
  if (quantity > 100000) throw new Error('That quantity is too large.');
  const basis = snapshot?.basis;
  if (!basis?.referenceAmount || !basis.referenceUnit) {
    throw new Error('Choose whether these values are per 100 g, per 100 ml, per serving, or per product.');
  }

  if (quantityUnit === 'serving') {
    const serving = snapshot.serving;
    if (!serving) throw new Error('This product does not include a serving size.');
    if (serving.nutrients?.calories) {
      return pack(scaleMap(serving.nutrients, quantity), scaleExtras(serving.extras, quantity), quantity, serving.label || 'per serving');
    }
    if (serving.unit === basis.referenceUnit) {
      const factor = (quantity * serving.amount) / basis.referenceAmount;
      return pack(scaleMap(snapshot.nutrients, factor), scaleExtras(snapshot.extras, factor), factor, basis.label);
    }
    throw new Error('This serving size uses a different unit, and the label did not include per-serving nutrition.');
  }

  if (quantityUnit !== basis.referenceUnit) {
    throw new Error(`Enter the amount in ${basis.referenceUnit}.`);
  }
  const factor = quantity / basis.referenceAmount;
  return pack(scaleMap(snapshot.nutrients, factor), scaleExtras(snapshot.extras, factor), factor, basis.label);
}

function pack(nutrients, extras, factor, basisLabel) {
  if (nutrients.calories == null) {
    throw new Error('Calories were not available, so this item cannot be added to the log.');
  }
  return { nutrients, extras, factor: roundAmount(factor), basisLabel };
}

export function sumNutrientMaps(maps) {
  const totals = {};
  for (const def of NUTRIENT_DEFS) {
    let sum = 0;
    let known = 0;
    for (const map of maps) {
      const value = map?.[def.key];
      if (value == null || value.amount == null) continue;
      sum += value.amount;
      known += 1;
    }
    totals[def.key] = known === 0
      ? { amount: null, unit: def.unit, partial: false, missing: maps.length, known: 0 }
      : {
          amount: roundAmount(sum),
          unit: def.unit,
          partial: known < maps.length,
          missing: maps.length - known,
          known,
        };
  }
  return totals;
}

export function sumExtras(lists) {
  const groups = new Map();
  lists.forEach((extras) => {
    for (const item of extras || []) {
      const id = `${item.key}|${item.unit}`;
      const group = groups.get(id) || { key: item.key, label: item.label, unit: item.unit, amount: 0, known: 0 };
      group.amount += item.amount;
      group.known += 1;
      groups.set(id, group);
    }
  });
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      label: group.label,
      unit: group.unit,
      amount: roundAmount(group.amount),
      known: group.known,
      partial: group.known < lists.length,
      missing: lists.length - group.known,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function sanitizeNutrientMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Nutrient data is missing.');
  }
  const out = blankNutrients();
  for (const def of NUTRIENT_DEFS) {
    if (!(def.key in input) || input[def.key] == null) continue;
    const raw = input[def.key];
    const amount = typeof raw === 'number' ? raw : raw.amount;
    const unit = typeof raw === 'number' ? def.unit : raw.unit;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`${def.label} must be a number that is zero or greater, or left empty.`);
    }
    if (amount > 1000000) throw new Error(`${def.label} is unreasonably large.`);
    if (canonicalUnit(unit) !== def.unit) throw new Error(`${def.label} must be in ${def.unit}.`);
    out[def.key] = { amount: roundAmount(amount), unit: def.unit };
  }
  return out;
}

export function sanitizeExtras(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('Additional nutrients were not in a readable format.');
  const allowed = new Set(['g', 'mg', 'µg', 'kcal']);
  return input.slice(0, 40).map((item) => {
    const key = String(item?.key || '');
    const label = String(item?.label || '').trim();
    const unit = canonicalUnit(item?.unit);
    if (!/^[a-z0-9_]{1,40}$/.test(key) || !label || label.length > 60 || !allowed.has(unit)) {
      throw new Error('An additional nutrient had an unsupported name or unit.');
    }
    if (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0 || item.amount > 1000000) {
      throw new Error(`${label} must be a number that is zero or greater.`);
    }
    return { key, label, unit, amount: roundAmount(item.amount) };
  });
}

const FIXED_BASIS = {
  per_100g: { referenceAmount: 100, referenceUnit: 'g', label: 'per 100 g' },
  per_100ml: { referenceAmount: 100, referenceUnit: 'ml', label: 'per 100 ml' },
  per_serving: { referenceAmount: 1, referenceUnit: 'serving', label: 'per serving' },
  per_product: { referenceAmount: 1, referenceUnit: 'product', label: 'per product' },
};

export function basisFromType(type, amount = null, unit = null) {
  if (FIXED_BASIS[type]) return { type, ...FIXED_BASIS[type] };
  if (type !== 'per_amount') throw new Error('The measurement basis is not supported.');
  const referenceUnit = ['g', 'ml', 'serving', 'product'].includes(unit) ? unit : canonicalUnit(unit);
  if (!['g', 'ml', 'serving', 'product'].includes(referenceUnit)) {
    throw new Error('The measurement unit is not supported.');
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('The reference amount is invalid.');
  }
  const referenceAmount = roundAmount(amount);
  const pretty = referenceUnit === 'g' || referenceUnit === 'ml'
    ? formatNumber(referenceAmount, 'g')
    : String(referenceAmount);
  return {
    type: 'per_amount',
    referenceAmount,
    referenceUnit,
    label: `per ${pretty} ${referenceUnit}`,
  };
}

export function sanitizeBasis(basis) {
  if (!basis || typeof basis !== 'object') throw new Error('The measurement basis is missing.');
  if (basis.type === 'per_amount') return basisFromType('per_amount', basis.referenceAmount, basis.referenceUnit);
  if (!FIXED_BASIS[basis.type]) throw new Error('The measurement basis is not supported.');
  return { type: basis.type, ...FIXED_BASIS[basis.type] };
}

export function sanitizeGoals(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const def of NUTRIENT_DEFS) {
    const raw = source[def.key];
    if (raw == null || raw === '') {
      out[def.key] = null;
      continue;
    }
    const amount = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`${def.label} goal must be greater than zero, or left empty.`);
    }
    if (amount > 1000000) throw new Error(`${def.label} goal is too large.`);
    out[def.key] = roundAmount(amount);
  }
  return out;
}

export function assertDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Use a date in YYYY-MM-DD format.');
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('That date is not a real calendar day.');
  }
  return value;
}

export function todayISO(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function shiftDate(iso, days) {
  const [year, month, day] = assertDate(iso).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return todayISO(date);
}
