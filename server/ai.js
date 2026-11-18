import {
  NUTRIENT_DEFS,
  blankNutrients,
  convertUnit,
  nutrientDef,
  roundAmount,
  sanitizeNutrientMap,
  unavailableLabels,
} from '../shared/nutrients.js';
import { HttpError } from './errors.js';
import { numberAppears, statedQuantities } from './extract.js';

const BASIS_EVIDENCE = {
  per_100g: /100\s*g\b/i,
  per_100ml: /100\s*ml\b/i,
  per_serving: /per\s+serving|\/\s*serving|each serving|serving size/i,
  per_product: /per\s+(pack|package|product|item|bar|bottle|pot)\b/i,
};

function activeApiKey(apiKey) {
  const provided = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (provided) return provided;
  return String(process.env.OPENAI_API_KEY || '').trim();
}

function aiConfigured(apiKey) {
  return Boolean(activeApiKey(apiKey));
}

function schemaHint() {
  const nutrients = Object.fromEntries(NUTRIENT_DEFS.map((def) => [def.key, { amount: null, unit: def.unit }]));
  return {
    productName: null,
    basis: null,
    nutrients,
  };
}

async function complete(messages, apiKey) {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const key = activeApiKey(apiKey);
  const body = {
    model,
    temperature: 0,
    messages,
  };
  const send = (payload) => fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });
  let response = await send({ ...body, response_format: { type: 'json_object' } });
  if (response.status === 400) {
    const detail = await response.text();
    if (/response_format|json_object/i.test(detail)) response = await send(body);
    else throw new HttpError(502, 'The nutrition extractor rejected the request.', 'AI_REJECTED');
  }
  if (!response.ok) {
    throw new HttpError(502, 'The nutrition extractor could not be reached.', 'AI_UNAVAILABLE');
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new HttpError(502, 'The nutrition extractor returned an empty result.', 'AI_EMPTY');
  }
  return content;
}

function parseModelJson(content) {
  const trimmed = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new HttpError(502, 'The nutrition extractor returned something we could not read.', 'AI_UNREADABLE');
  }
}

function groundedAmount(amount, unit, sourceText, stated) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  if (numberAppears(amount, sourceText)) return roundAmount(amount);
  for (const item of stated) {
    const converted = convertUnit(item.amount, item.unit, unit);
    if (converted == null) continue;
    if (Math.abs(roundAmount(converted, 2) - roundAmount(amount, 2)) < 0.001) return roundAmount(converted);
  }
  return null;
}

export function groundAiProduct(model, sourceText, pageUrl, hintedName) {
  const stated = statedQuantities(sourceText);
  const notes = ['Values were taken from the page text. A number was kept only when it appeared in the source, and missing nutrients were left empty.'];
  const draft = blankNutrients();
  const incoming = model?.nutrients && typeof model.nutrients === 'object' ? model.nutrients : {};
  for (const def of NUTRIENT_DEFS) {
    const raw = incoming[def.key];
    if (raw == null) continue;
    const amount = typeof raw === 'number' ? raw : raw.amount;
    if (amount == null) continue;
    const grounded = groundedAmount(amount, def.unit, sourceText, stated);
    if (grounded == null) {
      notes.push(`${def.label} was discarded because that number was not in the page text.`);
      continue;
    }
    draft[def.key] = { amount: grounded, unit: def.unit };
  }
  const nutrients = sanitizeNutrientMap(draft);
  const known = Object.values(nutrients).filter(Boolean);
  if (!known.length) return null;
  let basis = null;
  const requested = model?.basis;
  if (typeof requested === 'string' && BASIS_EVIDENCE[requested]?.test(sourceText)) {
    const table = {
      per_100g: { type: 'per_100g', referenceAmount: 100, referenceUnit: 'g', label: 'per 100 g' },
      per_100ml: { type: 'per_100ml', referenceAmount: 100, referenceUnit: 'ml', label: 'per 100 ml' },
      per_serving: { type: 'per_serving', referenceAmount: 1, referenceUnit: 'serving', label: 'per serving' },
      per_product: { type: 'per_product', referenceAmount: 1, referenceUnit: 'product', label: 'per product' },
    };
    basis = table[requested];
  } else if (requested) {
    notes.push('The measurement basis was not confirmed in the page text, so you need to choose it before adding this item.');
  }
  if (nutrients.calories == null) {
    const energy = sourceText.match(/([\d]+(?:[.,]\d+)?)\s*kJ\b/i);
    if (energy && /energy|calor/i.test(sourceText)) {
      const parsed = Number(energy[1].replace(',', ''));
      const kcal = convertUnit(parsed, 'kJ', 'kcal');
      if (kcal != null) {
        nutrients.calories = { amount: roundAmount(kcal), unit: 'kcal' };
        notes.push('Calories were converted from kilojoules stated on the page.');
      }
    }
  }
  const missing = unavailableLabels(nutrients);
  if (missing.length) notes.push(`Not stated in the page text: ${missing.join(', ')}.`);
  const modelName = typeof model?.productName === 'string' ? model.productName.trim() : '';
  const name = (modelName && sourceText.toLowerCase().includes(modelName.toLowerCase()) ? modelName : hintedName) || 'Unnamed product';
  return {
    name: name.slice(0, 160),
    brand: null,
    description: null,
    basis,
    nutrients,
    extras: [],
    serving: null,
    basisOptions: basis ? null : ['per_100g', 'per_100ml', 'per_serving', 'per_product'],
    provenance: {
      provider: 'ai',
      reference: pageUrl,
      confidence: 'extracted',
      retrievedAt: new Date().toISOString(),
      notes,
    },
  };
}

export async function extractNutritionWithAi({ sourceText, pageUrl, hintedName, apiKey }) {
  if (!aiConfigured(apiKey)) return { configured: false, product: null };
  const excerpt = String(sourceText || '').slice(0, 12000);
  if (!excerpt.trim()) return { configured: true, product: null };
  const content = await complete([
    {
      role: 'system',
      content: `You extract nutrition facts that are explicitly printed in the source text. Return one JSON object and nothing else.
Rules:
- If a nutrient is not explicitly given as a number, set amount to null.
- Never estimate, infer, or fill a typical value.
- Use 0 only when the source explicitly says 0.
- Do not derive one nutrient from another.
- Convert a unit only when the source states the original unit.
- basis must be "per_100g", "per_100ml", "per_serving", "per_product", or null.
- productName must be copied from the source, or null.
Use this shape: ${JSON.stringify(schemaHint())}`,
    },
    {
      role: 'user',
      content: `Page: ${pageUrl}\n\n${excerpt}`,
    },
  ], apiKey);
  const model = parseModelJson(content);
  return { configured: true, product: groundAiProduct(model, excerpt, pageUrl, hintedName) };
}

export function aiIsConfigured() {
  return aiConfigured();
}
