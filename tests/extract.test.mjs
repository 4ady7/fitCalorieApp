import assert from 'node:assert/strict';
import test from 'node:test';
import { consumedFromSnapshot } from '../shared/nutrients.js';
import { extractProductFromHtml, numberAppears } from '../server/extract.js';
import { mapOffProduct } from '../server/openfoodfacts.js';
import { groundAiProduct } from '../server/ai.js';

const NUTELLA_HTML = `<!doctype html>
<html><head>
  <title>Nutella – Ferrero – 400 g</title>
  <meta property="og:title" content="Nutella – Ferrero – 400 g" />
  <meta name="description" content="Hazelnut spread with cocoa." />
</head><body>
  <h1>Nutella – Ferrero – 400 g</h1>
  <table aria-label="Nutrition facts">
    <tr><th>Nutrition facts</th><th>As sold for 100 g / 100 ml</th><th>Compared to: spreads</th></tr>
    <tr><td>Energy</td><td>2,252 kJ (539 kcal)</td><td>435 kcal (+23%)</td></tr>
    <tr><td>Fat</td><td>30.9 g</td><td>19 g</td></tr>
    <tr><td>Saturated fat</td><td>10.6 g</td><td>4 g</td></tr>
    <tr><td>Carbohydrates</td><td>57.5 g</td><td>59 g</td></tr>
    <tr><td>Sugars</td><td>56.3 g</td><td>56 g</td></tr>
    <tr><td>Fiber</td><td>0 g</td><td>1.8 g</td></tr>
    <tr><td>Proteins</td><td>6.3 g</td><td>3 g</td></tr>
    <tr><td>Salt</td><td>0.107 g</td><td>0.12 g</td></tr>
    <tr><td>Sodium</td><td>~ 0.043 g</td><td>0.046 g</td></tr>
  </table>
</body></html>`;

test('reads a nutrition table without taking the comparison column', () => {
  const { product } = extractProductFromHtml(NUTELLA_HTML, 'https://example.test/nutella');
  assert.equal(product.name.includes('Nutella'), true);
  assert.equal(product.basis.type, 'per_100g');
  assert.equal(product.nutrients.calories.amount, 539);
  assert.equal(product.nutrients.fat.amount, 30.9);
  assert.equal(product.nutrients.fibre.amount, 0);
  assert.equal(product.nutrients.protein.amount, 6.3);
  assert.equal(product.nutrients.salt.amount, 0.107);
  assert.equal(product.nutrients.sodium.amount, 43);
  assert.equal(product.nutrients.vitamin_c, null);
  assert.equal(product.provenance.provider, 'page_structured');
  assert.equal(product.provenance.notes.some((note) => /100 g/.test(note)), true);
});

test('maps an Open Food Facts payload and keeps zero distinct from missing vitamins', () => {
  const product = mapOffProduct({
    code: '3017620422003',
    product_name: 'Nutella',
    brands: 'Ferrero',
    quantity: '400 g',
    nutrition_data_per: '100g',
    nutriments: {
      'energy-kcal_100g': 539,
      'energy-kcal_unit': 'kcal',
      proteins_100g: 6.3,
      proteins_unit: 'g',
      carbohydrates_100g: 57.5,
      carbohydrates_unit: 'g',
      fat_100g: 30.9,
      fat_unit: 'g',
      'saturated-fat_100g': 10.6,
      'saturated-fat_unit': 'g',
      fiber_100g: 0,
      fiber_unit: 'g',
      sugars_100g: 56.3,
      sugars_unit: 'g',
      salt_100g: 0.107,
      salt_unit: 'g',
      sodium_100g: 0.0428,
      sodium_unit: 'g',
      'vitamin-c_100g': 0.028,
      'vitamin-c_unit': 'g',
    },
  });
  assert.equal(product.nutrients.calories.amount, 539);
  assert.equal(product.nutrients.fibre.amount, 0);
  assert.equal(product.nutrients.sodium.amount, 42.8);
  assert.equal(product.nutrients.vitamin_c.amount, 28);
  assert.equal(product.nutrients.vitamin_a, null);
  assert.equal(product.provenance.confidence, 'verified');
});

test('uses per-serving facts when a serving is selected and per 100 g otherwise', () => {
  const product = mapOffProduct({
    code: '5449000000996',
    product_name: 'Coca-Cola',
    nutrition_data_per: '100g',
    serving_size: '1 portion (330 ml)',
    serving_quantity: 330,
    nutriments: {
      'energy-kcal_100g': 44,
      'energy-kcal_serving': 145,
      'energy-kcal_unit': 'kcal',
      fat_100g: 0,
      fat_serving: 0,
      fat_unit: 'g',
      sugars_100g: 10.9,
      sugars_serving: 36,
      sugars_unit: 'g',
    },
  });
  const oneServing = consumedFromSnapshot(product, 1, 'serving');
  const hundredGrams = consumedFromSnapshot(product, 100, 'g');
  assert.equal(oneServing.nutrients.calories.amount, 145);
  assert.equal(oneServing.nutrients.fat.amount, 0);
  assert.equal(oneServing.nutrients.sugars.amount, 36);
  assert.equal(oneServing.nutrients.protein, null);
  assert.equal(hundredGrams.nutrients.calories.amount, 44);
});

test('AI grounding keeps numbers present in the source and drops invented ones', () => {
  const source = 'Sample Bar. Nutrition per 100 g. Calories 250 kcal. Carbohydrates 30 g. Fat 8 g. Fibre 4 g.';
  const product = groundAiProduct({
    productName: 'Sample Bar',
    basis: 'per_100g',
    nutrients: {
      calories: { amount: 250, unit: 'kcal' },
      protein: { amount: 99, unit: 'g' },
      carbohydrates: { amount: 30, unit: 'g' },
      fat: { amount: 8, unit: 'g' },
      fibre: { amount: 4, unit: 'g' },
      iron: { amount: 0, unit: 'mg' },
    },
  }, source, 'https://example.test/bar', 'Sample Bar');
  assert.equal(product.basis.type, 'per_100g');
  assert.equal(product.nutrients.calories.amount, 250);
  assert.equal(product.nutrients.carbohydrates.amount, 30);
  assert.equal(product.nutrients.fat.amount, 8);
  assert.equal(product.nutrients.fibre.amount, 4);
  assert.equal(product.nutrients.protein, null);
  assert.equal(product.nutrients.iron, null);
  assert.equal(product.provenance.provider, 'ai');
  assert.equal(product.provenance.notes.some((note) => /Protein was discarded/.test(note)), true);
  assert.equal(numberAppears(250, source), true);
  assert.equal(numberAppears(99, source), false);
});
