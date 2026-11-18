import * as cheerio from 'cheerio';
import {
  blankNutrients,
  convertUnit,
  nutrientDef,
  roundAmount,
  sanitizeExtras,
  sanitizeNutrientMap,
  unavailableLabels,
} from '../shared/nutrients.js';

const LABEL_RULES = [
  [/^(energy|calories|énergie|energie)$/, 'calories'],
  [/^proteins?$/, 'protein'],
  [/^(carbohydrates?|total carbohydrate)$/, 'carbohydrates'],
  [/^(total fat|fat)$/, 'fat'],
  [/^(saturated fat|saturates)$/, 'saturated_fat'],
  [/^(dietary fibre|dietary fiber|fibre|fiber)$/, 'fibre'],
  [/^sugars?$/, 'sugars'],
  [/^sodium$/, 'sodium'],
  [/^salt$/, 'salt'],
  [/^potassium$/, 'potassium'],
  [/^calcium$/, 'calcium'],
  [/^iron$/, 'iron'],
  [/^magnesium$/, 'magnesium'],
  [/^zinc$/, 'zinc'],
  [/^vitamin a$/, 'vitamin_a'],
  [/^vitamin c$/, 'vitamin_c'],
  [/^vitamin d$/, 'vitamin_d'],
  [/^vitamin e$/, 'vitamin_e'],
  [/^(vitamin b12|vitamin b-12)$/, 'vitamin_b12'],
];

const EXTRA_RULES = [
  [/^cholesterol$/, 'cholesterol', 'Cholesterol', 'mg'],
  [/^(vitamin b1|thiamin|thiamine)$/, 'vitamin_b1', 'Vitamin B1', 'mg'],
  [/^(vitamin b2|riboflavin)$/, 'vitamin_b2', 'Vitamin B2', 'mg'],
  [/^(vitamin b3|niacin)$/, 'vitamin_b3', 'Vitamin B3', 'mg'],
  [/^vitamin b6$/, 'vitamin_b6', 'Vitamin B6', 'mg'],
  [/^(vitamin b9|folate|folic acid)$/, 'vitamin_b9', 'Vitamin B9', 'µg'],
  [/^vitamin k$/, 'vitamin_k', 'Vitamin K', 'µg'],
  [/^phosphorus$/, 'phosphorus', 'Phosphorus', 'mg'],
  [/^iodine$/, 'iodine', 'Iodine', 'µg'],
  [/^selenium$/, 'selenium', 'Selenium', 'µg'],
  [/^copper$/, 'copper', 'Copper', 'mg'],
  [/^manganese$/, 'manganese', 'Manganese', 'mg'],
];

export function cleanText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalLabel(value) {
  return cleanText(value).toLowerCase().replace(/^of which\s+/, '').replace(/[:*]+$/, '').trim();
}

function parseNumber(raw) {
  let text = raw.trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  else if (text.includes(',') && !text.includes('.')) text = text.replace(',', '.');
  else text = text.replace(/,/g, '');
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

/** Pull a measured value out of a label cell. Prefers kcal when energy is written both ways. */
export function parseQuantity(raw) {
  const text = cleanText(raw).replace(/~/g, ' ');
  if (!text || text === '?' || text === '-' || text === '—' || text === '–') return null;
  const patterns = [
    [/([\d]+(?:[.,]\d+)?)\s*(kcal|calories)\b/i, 'kcal'],
    [/([\d]+(?:[.,]\d+)?)\s*(kilojoules|kj)\b/i, 'kJ'],
    [/([\d]+(?:[.,]\d+)?)\s*(µg|μg|ug|mcg|micrograms)\b/i, 'µg'],
    [/([\d]+(?:[.,]\d+)?)\s*(milligrams|mg)\b/i, 'mg'],
    [/([\d]+(?:[.,]\d+)?)\s*(kilograms|kg)\b/i, 'kg'],
    [/([\d]+(?:[.,]\d+)?)\s*(grams|gram|g)\b/i, 'g'],
    [/([\d]+(?:[.,]\d+)?)\s*(millilitres|milliliters|ml)\b/i, 'ml'],
    [/([\d]+(?:[.,]\d+)?)\s*(litres|liters|l)\b/i, 'l'],
  ];
  for (const [pattern, unit] of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = parseNumber(match[1]);
    if (amount == null) return null;
    if (unit === 'kg') return { amount: amount * 1000, unit: 'g', approximate: text.includes('~') || raw.includes('~') };
    return { amount, unit, approximate: /~/.test(raw) };
  }
  return null;
}

export function statedQuantities(text) {
  const found = [];
  const pattern = /([\d]+(?:[.,]\d+)?)\s*(kcal|calories|kilojoules|kj|µg|μg|ug|mcg|micrograms|milligrams|mg|kilograms|kg|grams|gram|g|millilitres|milliliters|ml|litres|liters|l)\b/gi;
  for (const match of String(text).matchAll(pattern)) {
    const parsed = parseQuantity(`${match[1]} ${match[2]}`);
    if (parsed) found.push(parsed);
  }
  return found;
}

function applyParsed(nutrients, extras, notes, key, parsed, targetUnit, label) {
  if (!parsed) return false;
  const converted = convertUnit(parsed.amount, parsed.unit, targetUnit);
  if (converted == null) {
    notes.push(`${label} was listed in ${parsed.unit} and was left out so units would not be mixed.`);
    return false;
  }
  if (nutrientDef(key)) nutrients[key] = { amount: roundAmount(converted), unit: targetUnit };
  else extras.push({ key, label, unit: targetUnit, amount: roundAmount(converted) });
  if (parsed.approximate) notes.push(`${label} was marked as approximate on the page.`);
  return true;
}

function knownCount(nutrients, extras) {
  return Object.values(nutrients).filter(Boolean).length + extras.length;
}

function isSkippedHeading(heading) {
  return /compar|daily value|reference intake|%|\bri\b/i.test(cleanText(heading));
}

function classifyHeading(heading) {
  const header = cleanText(heading);
  if (!header || isSkippedHeading(header)) return { kind: 'skip', header };
  const hasG = /100\s*g\b/i.test(header);
  const hasMl = /100\s*ml\b/i.test(header);
  if (hasG && hasMl) return { kind: 'ambiguous', header };
  if (hasG) {
    return {
      kind: 'per_100g',
      header,
      basis: { type: 'per_100g', referenceAmount: 100, referenceUnit: 'g', label: 'per 100 g' },
    };
  }
  if (hasMl) {
    return {
      kind: 'per_100ml',
      header,
      basis: { type: 'per_100ml', referenceAmount: 100, referenceUnit: 'ml', label: 'per 100 ml' },
    };
  }
  const sized = header.match(/\((\d+(?:[.,]\d+)?)\s*(g|ml)\)/i);
  const sizeUnit = sized?.[2]?.toLowerCase();
  const sizeAmount = sized ? Number(sized[1].replace(',', '.')) : null;
  if (/pack|serving|portion/i.test(header) || sizeAmount) {
    return {
      kind: 'portion',
      header,
      grams: sizeUnit === 'g' ? sizeAmount : null,
      ml: sizeUnit === 'ml' ? sizeAmount : null,
    };
  }
  return { kind: 'unknown', header };
}

function portionLabel(header, grams, ml) {
  const size = grams ? `${grams} g` : ml ? `${ml} ml` : '';
  if (/1\s*\/\s*2|½|half/i.test(header) && /pack/i.test(header)) {
    return size ? `1/2 pack (${size})` : '1/2 pack';
  }
  if (/pack/i.test(header)) return size ? `1 pack (${size})` : '1 pack';
  return size ? `1 serving (${size})` : '1 serving';
}

function decideBasis(header, title) {
  const hasG = /100\s*g\b/i.test(header);
  const hasMl = /100\s*ml\b/i.test(header);
  const serving = /per\s+serving|\/\s*serving|each serving/i.test(header);
  const product = /per\s+(pack|package|product|item|bottle|bar)\b/i.test(header);
  if (hasG && hasMl) {
    const size = cleanText(title).match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i);
    const unit = size?.[2]?.toLowerCase();
    if (unit === 'g' || unit === 'kg') {
      return {
        basis: { type: 'per_100g', referenceAmount: 100, referenceUnit: 'g', label: 'per 100 g' },
        note: 'The table heading listed both 100 g and 100 ml. The product size is in grams, so the values were read per 100 g.',
      };
    }
    if (unit === 'ml' || unit === 'l') {
      return {
        basis: { type: 'per_100ml', referenceAmount: 100, referenceUnit: 'ml', label: 'per 100 ml' },
        note: 'The table heading listed both 100 g and 100 ml. The product size is in millilitres, so the values were read per 100 ml.',
      };
    }
    return {
      basis: null,
      basisOptions: ['per_100g', 'per_100ml'],
      note: 'The table heading listed both 100 g and 100 ml. Choose the basis printed on the package before adding this item.',
    };
  }
  if (hasG) return { basis: { type: 'per_100g', referenceAmount: 100, referenceUnit: 'g', label: 'per 100 g' } };
  if (hasMl) return { basis: { type: 'per_100ml', referenceAmount: 100, referenceUnit: 'ml', label: 'per 100 ml' } };
  if (serving) return { basis: { type: 'per_serving', referenceAmount: 1, referenceUnit: 'serving', label: 'per serving' } };
  if (product) return { basis: { type: 'per_product', referenceAmount: 1, referenceUnit: 'product', label: 'per product' } };
  return {
    basis: null,
    basisOptions: ['per_100g', 'per_100ml', 'per_serving', 'per_product'],
    note: 'The page did not say whether these values are per 100 g, per 100 ml, per serving, or per product.',
  };
}

function matrixFromTable($, table) {
  const rows = [];
  $(table).find('tr').each((_, tr) => {
    const cells = [];
    $(tr).find('th,td').each((__, cell) => cells.push(cleanText($(cell).text())));
    if (cells.some(Boolean)) rows.push(cells);
  });
  return rows;
}

function readColumn(dataRows, valueIndex) {
  const nutrients = blankNutrients();
  const extras = [];
  const notes = [];
  for (const row of dataRows) {
    const label = normalLabel(row[0] || '');
    const raw = row[valueIndex] || '';
    const parsed = parseQuantity(raw);
    if (!parsed) continue;
    const core = LABEL_RULES.find(([pattern]) => pattern.test(label));
    if (core) {
      const def = nutrientDef(core[1]);
      applyParsed(nutrients, extras, notes, def.key, parsed, def.unit, def.label);
      continue;
    }
    const extra = EXTRA_RULES.find(([pattern]) => pattern.test(label));
    if (extra) applyParsed(nutrients, extras, notes, extra[1], parsed, extra[3], extra[2]);
  }
  return {
    nutrients: sanitizeNutrientMap(nutrients),
    extras: sanitizeExtras(extras),
    notes,
  };
}

function portionServing(column) {
  const info = column.classification;
  const label = portionLabel(info.header, info.grams, info.ml);
  return {
    amount: info.grams || info.ml || 1,
    unit: info.grams ? 'g' : info.ml ? 'ml' : (/pack/i.test(info.header) ? 'product' : 'serving'),
    label,
    nutrients: column.nutrients,
    extras: column.extras,
  };
}

function parseTable($, table, title) {
  const rows = matrixFromTable($, table);
  if (rows.length < 2) return null;
  const header = rows[0].join(' ');
  const headerLooksUseful = /100\s*g|100\s*ml|serving|pack|portion|nutrition/i.test(header);
  const dataRows = headerLooksUseful ? rows.slice(1) : rows;
  const columnCount = Math.max(...rows.map((row) => row.length));
  const columns = [];
  for (let index = 1; index < columnCount; index += 1) {
    const heading = headerLooksUseful ? rows[0][index] || '' : header;
    const classification = headerLooksUseful ? classifyHeading(heading) : { kind: 'unknown', header: heading };
    if (classification.kind === 'skip') continue;
    const parsed = readColumn(dataRows, index);
    if (knownCount(parsed.nutrients, parsed.extras) < 2) continue;
    columns.push({ index, classification, ...parsed });
  }
  if (!columns.length) return null;

  const reference = columns.find((column) => ['per_100g', 'per_100ml', 'ambiguous'].includes(column.classification.kind));
  const portion = columns.find((column) => column.classification.kind === 'portion');
  const primary = reference || portion || columns[0];
  const notes = [...primary.notes];
  let basis = null;
  let basisOptions = null;
  let serving = null;

  if (primary.classification.kind === 'per_100g' || primary.classification.kind === 'per_100ml') {
    basis = primary.classification.basis;
  } else if (primary.classification.kind === 'portion') {
    const info = primary.classification;
    const namedPack = /pack/i.test(info.header) && !info.grams && !info.ml;
    basis = namedPack
      ? { type: 'per_product', referenceAmount: 1, referenceUnit: 'product', label: 'per product' }
      : { type: 'per_serving', referenceAmount: 1, referenceUnit: 'serving', label: 'per serving' };
    serving = portionServing(primary);
  } else {
    const decision = decideBasis(primary.classification.header || header, title);
    basis = decision.basis;
    basisOptions = decision.basisOptions || null;
    if (decision.note) notes.push(decision.note);
  }

  if (reference && portion) {
    serving = portionServing(portion);
    notes.push(
      `One serving uses the published “${serving.label}” column. A quantity in ${basis.referenceUnit} uses the ${basis.label} column, so the two are not mixed.`,
    );
  }

  return {
    nutrients: primary.nutrients,
    extras: primary.extras,
    basis,
    basisOptions,
    notes,
    serving,
  };
}

function nodesOf(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function collectJsonLd(node, acc, seen = new Set()) {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((item) => collectJsonLd(item, acc, seen));
    return;
  }
  const types = nodesOf(node['@type']).map((type) => String(type).toLowerCase());
  if (types.includes('nutritioninformation')) acc.nutrition.push(node);
  if (types.includes('product')) acc.products.push(node);
  if (node['@graph']) collectJsonLd(node['@graph'], acc, seen);
  if (node.nutrition) collectJsonLd(node.nutrition, acc, seen);
}

function jsonLdBasis(nutrition) {
  const serving = cleanText(nutrition.servingSize || '');
  const parsed = serving ? parseQuantity(serving) : null;
  if (parsed?.unit === 'g' && parsed.amount === 100) {
    return { basis: { type: 'per_100g', referenceAmount: 100, referenceUnit: 'g', label: 'per 100 g' } };
  }
  if (parsed?.unit === 'ml' && parsed.amount === 100) {
    return { basis: { type: 'per_100ml', referenceAmount: 100, referenceUnit: 'ml', label: 'per 100 ml' } };
  }
  if (parsed && (parsed.unit === 'g' || parsed.unit === 'ml')) {
    return {
      basis: {
        type: 'per_amount',
        referenceAmount: parsed.amount,
        referenceUnit: parsed.unit,
        label: `per ${parsed.amount} ${parsed.unit}`,
      },
    };
  }
  if (serving) return { basis: { type: 'per_serving', referenceAmount: 1, referenceUnit: 'serving', label: 'per serving' } };
  return {
    basis: null,
    basisOptions: ['per_100g', 'per_100ml', 'per_serving', 'per_product'],
    note: 'The structured product data did not state a measurement basis.',
  };
}

const JSON_LD_FIELDS = [
  ['calories', 'calories'],
  ['proteinContent', 'protein'],
  ['carbohydrateContent', 'carbohydrates'],
  ['fatContent', 'fat'],
  ['saturatedFatContent', 'saturated_fat'],
  ['fiberContent', 'fibre'],
  ['sugarContent', 'sugars'],
  ['sodiumContent', 'sodium'],
];

function parseJsonLdNutrition(nutrition) {
  const nutrients = blankNutrients();
  const notes = [];
  for (const [field, key] of JSON_LD_FIELDS) {
    if (nutrition[field] == null) continue;
    const def = nutrientDef(key);
    const parsed = parseQuantity(String(nutrition[field]));
    applyParsed(nutrients, [], notes, def.key, parsed, def.unit, def.label);
  }
  if (knownCount(nutrients, []) < 2) return null;
  const decision = jsonLdBasis(nutrition);
  if (decision.note) notes.push(decision.note);
  return {
    nutrients: sanitizeNutrientMap(nutrients),
    extras: [],
    basis: decision.basis,
    basisOptions: decision.basisOptions || null,
    notes,
    name: null,
  };
}

function finishProduct({ name, description, extracted, pageUrl }) {
  const notes = [...extracted.notes];
  const missing = unavailableLabels(extracted.nutrients);
  if (missing.length) notes.push(`Not stated on the page: ${missing.join(', ')}.`);
  return {
    name: cleanText(name).slice(0, 160) || 'Unnamed product',
    brand: null,
    description: cleanText(description).slice(0, 280) || null,
    basis: extracted.basis,
    nutrients: extracted.nutrients,
    extras: extracted.extras,
    serving: extracted.serving || null,
    basisOptions: extracted.basis ? null : extracted.basisOptions,
    provenance: {
      provider: 'page_structured',
      reference: pageUrl,
      confidence: 'extracted',
      retrievedAt: new Date().toISOString(),
      notes: [...new Set(notes)],
    },
  };
}

export function extractProductFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const title = cleanText($('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text());
  const description = cleanText($('meta[name="description"]').attr('content') || '');
  const candidates = [];
  let structuredName = '';

  $('script[type="application/ld+json"]').each((_, script) => {
    let data;
    try {
      data = JSON.parse($(script).text());
    } catch {
      return;
    }
    const acc = { nutrition: [], products: [] };
    collectJsonLd(data, acc);
    const productName = acc.products.map((product) => product.name).find(Boolean);
    if (!structuredName && productName) structuredName = cleanText(productName);
    for (const nutrition of acc.nutrition) {
      const extracted = parseJsonLdNutrition(nutrition);
      if (extracted) candidates.push({ extracted, name: productName || title, score: knownCount(extracted.nutrients, extracted.extras) + 1 });
    }
  });

  $('table').each((_, table) => {
    const extracted = parseTable($, table, title);
    if (extracted) candidates.push({ extracted, name: structuredName || title, score: knownCount(extracted.nutrients, extracted.extras) });
  });

  $('script, style, noscript').remove();
  const text = cleanText(`${title}\n${$('body').text()}`).slice(0, 20000);
  if (!candidates.length) return { product: null, text, title, description };
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return {
    product: finishProduct({ name: best.name, description, extracted: best.extracted, pageUrl }),
    text,
    title,
    description,
  };
}

export function numberAppears(amount, text) {
  const forms = new Set([String(amount), amount.toFixed(1), amount.toFixed(2), amount.toFixed(3)]);
  const normalized = String(text).replace(/(\d),(\d{3})\b/g, '$1$2').replace(/(\d),(\d)/g, '$1.$2');
  for (const form of forms) {
    const trimmed = form.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const escaped = trimmed.replace('.', '\\.');
    if (new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(normalized)) return true;
  }
  return false;
}
