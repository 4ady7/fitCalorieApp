import { convertUnit, nutrientDef, roundAmount, sanitizeExtras, sanitizeNutrientMap } from '../shared/nutrients.js';
import { HttpError } from './errors.js';

export const OFF_USER_AGENT = 'FitCalorie/1.0 (personal nutrition tracker)';

const CORE = [
  ['energy-kcal', 'calories'],
  ['proteins', 'protein'],
  ['carbohydrates', 'carbohydrates'],
  ['fat', 'fat'],
  ['saturated-fat', 'saturated_fat'],
  ['monounsaturated-fat', 'monounsaturated_fat'],
  ['polyunsaturated-fat', 'polyunsaturated_fat'],
  ['fiber', 'fibre'],
  ['sugars', 'sugars'],
  ['added-sugars', 'added_sugars'],
  ['sodium', 'sodium'],
  ['salt', 'salt'],
  ['potassium', 'potassium'],
  ['calcium', 'calcium'],
  ['iron', 'iron'],
  ['magnesium', 'magnesium'],
  ['zinc', 'zinc'],
  ['vitamin-a', 'vitamin_a'],
  ['vitamin-c', 'vitamin_c'],
  ['vitamin-d', 'vitamin_d'],
  ['vitamin-e', 'vitamin_e'],
  ['vitamin-b12', 'vitamin_b12'],
];

const EXTRAS = [
  ['vitamin-b1', 'vitamin_b1', 'Vitamin B1', 'mg'],
  ['vitamin-b2', 'vitamin_b2', 'Vitamin B2', 'mg'],
  ['vitamin-pp', 'vitamin_b3', 'Vitamin B3', 'mg'],
  ['vitamin-b6', 'vitamin_b6', 'Vitamin B6', 'mg'],
  ['vitamin-b9', 'vitamin_b9', 'Vitamin B9', 'µg'],
  ['vitamin-k', 'vitamin_k', 'Vitamin K', 'µg'],
  ['phosphorus', 'phosphorus', 'Phosphorus', 'mg'],
  ['iodine', 'iodine', 'Iodine', 'µg'],
  ['copper', 'copper', 'Copper', 'mg'],
  ['manganese', 'manganese', 'Manganese', 'mg'],
  ['selenium', 'selenium', 'Selenium', 'µg'],
  ['cholesterol', 'cholesterol', 'Cholesterol', 'mg'],
];

function defaultOffUnit(offKey) {
  if (offKey === 'energy-kcal') return 'kcal';
  if (offKey === 'energy-kj') return 'kJ';
  return 'g';
}

function readOffValue(nutriments, offKey, canonical, suffix, notes, label) {
  const field = `${offKey}${suffix}`;
  if (!Object.prototype.hasOwnProperty.call(nutriments, field)) return null;
  const amount = nutriments[field];
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  const statedUnit = nutriments[`${offKey}_unit`] || defaultOffUnit(offKey);
  const converted = convertUnit(amount, statedUnit, canonical);
  if (converted == null) {
    notes.push(`${label} was listed in ${statedUnit} and was left out so units would not be mixed.`);
    return null;
  }
  return { amount: roundAmount(converted), unit: canonical, converted: statedUnit !== canonical };
}

function readSet(nutriments, suffix) {
  const notes = [];
  const draft = {};
  let convertedUnits = false;
  for (const [offKey, key] of CORE) {
    const def = nutrientDef(key);
    const value = readOffValue(nutriments, offKey, def.unit, suffix, notes, def.label);
    if (value?.converted) convertedUnits = true;
    draft[key] = value ? { amount: value.amount, unit: value.unit } : null;
  }
  if (draft.calories == null) {
    const kjField = `energy-kj${suffix}`;
    if (typeof nutriments[kjField] === 'number') {
      const converted = convertUnit(nutriments[kjField], nutriments['energy-kj_unit'] || 'kJ', 'kcal');
      if (converted != null) {
        draft.calories = { amount: roundAmount(converted), unit: 'kcal' };
        notes.push('Calories were converted from kilojoules stated by Open Food Facts.');
      }
    }
  }
  const extras = [];
  for (const [offKey, key, label, unit] of EXTRAS) {
    const value = readOffValue(nutriments, offKey, unit, suffix, notes, label);
    if (value?.converted) convertedUnits = true;
    if (value) extras.push({ key, label, unit, amount: value.amount });
  }
  if (convertedUnits) notes.push('Some amounts were converted into the units used by this log. The original numbers were not estimated.');
  return {
    nutrients: sanitizeNutrientMap(draft),
    extras: sanitizeExtras(extras),
    notes,
  };
}

function servingUnit(servingSize, fallback) {
  if (/ml\b/i.test(servingSize || '')) return 'ml';
  if (/\bg\b/i.test(servingSize || '')) return 'g';
  return fallback;
}

export function mapOffProduct(product) {
  if (!product || typeof product !== 'object') {
    throw new HttpError(502, 'Open Food Facts returned a product we could not read.', 'BAD_UPSTREAM');
  }
  const nutriments = product.nutriments && typeof product.nutriments === 'object' ? product.nutriments : {};
  const per = product.nutrition_data_per || '100g';
  let basis;
  let suffix = '_100g';
  const notes = [];
  if (per === 'serving') {
    suffix = '_serving';
    basis = { type: 'per_serving', referenceAmount: 1, referenceUnit: 'serving', label: 'per serving' };
  } else if (per === '100ml') {
    basis = { type: 'per_100ml', referenceAmount: 100, referenceUnit: 'ml', label: 'per 100 ml' };
    notes.push('Open Food Facts stores these per-100-ml values in its per-100-g fields. They were read as per 100 ml.');
  } else {
    basis = { type: 'per_100g', referenceAmount: 100, referenceUnit: 'g', label: 'per 100 g' };
  }

  const primary = readSet(nutriments, suffix);
  notes.push(...primary.notes);
  notes.push('Missing nutrients were left empty rather than recorded as zero.');

  let serving = null;
  const servingQuantity = Number(product.serving_quantity);
  if (Number.isFinite(servingQuantity) && servingQuantity > 0 && per !== 'serving') {
    const servingValues = readSet(nutriments, '_serving');
    const unit = servingUnit(product.serving_size, basis.referenceUnit);
    serving = {
      amount: roundAmount(servingQuantity),
      unit,
      label: product.serving_size ? `1 serving (${product.serving_size})` : '1 serving',
      nutrients: servingValues.nutrients.calories ? servingValues.nutrients : null,
      extras: servingValues.nutrients.calories ? servingValues.extras : [],
    };
  }

  const name = String(product.product_name || product.generic_name || 'Unnamed product').trim().slice(0, 160);
  const brand = product.brands ? String(product.brands).split(',')[0].trim().slice(0, 80) : null;
  const description = [product.quantity, product.generic_name].filter(Boolean).map(String).join(' · ').slice(0, 280) || null;

  return {
    name,
    brand,
    description,
    basis,
    nutrients: primary.nutrients,
    extras: primary.extras,
    serving,
    basisOptions: null,
    provenance: {
      provider: 'openfoodfacts',
      reference: String(product.code || ''),
      confidence: 'verified',
      retrievedAt: new Date().toISOString(),
      notes: [...new Set(notes)],
    },
  };
}

export async function fetchOffProduct(code) {
  let response;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json`, {
        headers: {
          accept: 'application/json',
          'user-agent': OFF_USER_AGENT,
        },
        signal: AbortSignal.timeout(12000),
      });
    } catch (error) {
      lastError = error;
      response = null;
    }
    if (response && (response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }
    if (!response && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }
    break;
  }
  if (!response) {
    if (lastError?.name === 'TimeoutError' || lastError?.name === 'AbortError') {
      throw new HttpError(502, 'Open Food Facts took too long to respond. Try again.', 'UPSTREAM_TIMEOUT');
    }
    throw new HttpError(502, 'Open Food Facts could not be reached. Try again in a moment.', 'UPSTREAM_UNAVAILABLE');
  }
  if (!response.ok && response.status !== 404) {
    throw new HttpError(502, 'Open Food Facts could not be reached. Try again in a moment.', 'UPSTREAM_UNAVAILABLE');
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new HttpError(502, 'Open Food Facts returned a response we could not read.', 'BAD_UPSTREAM');
  }
  if (body.status !== 1) {
    const verbose = String(body.status_verbose || '');
    if (/invalid/i.test(verbose)) {
      throw new HttpError(400, 'That barcode is not a valid product code.', 'INVALID_BARCODE');
    }
    throw new HttpError(404, `No product was found for barcode ${code}.`, 'PRODUCT_NOT_FOUND');
  }
  return mapOffProduct({ ...body.product, code: body.code || body.product?.code || code });
}
