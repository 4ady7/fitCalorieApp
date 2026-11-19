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

function groceryPage({ name, size, table }) {
  return `<!doctype html><html><head><title>${name} - Shop</title>
    <script type="application/ld+json">{"@type":"Product","name":"${name}","size":"${size}"}</script>
    </head><body><h1>${name}</h1>${table}</body></html>`;
}

test('keeps a per 100 g column separate from a half-pack column and the reference intake', () => {
  const html = groceryPage({
    name: 'Morrisons Hunters Chicken 430g',
    size: '430g',
    table: `<table>
      <tr><th>Typical Values</th><th>(as consumed) per 100g</th><th>(as consumed) per 1/2 pack (195g)</th><th>%RI</th><th>your RI*</th></tr>
      <tr><td>Energy</td><td>581kJ/138kcal</td><td>1133kJ/269kcal</td><td>13%</td><td>8400kJ/2000kcal</td></tr>
      <tr><td>Fat</td><td>4.8g</td><td>9.4g</td><td>13%</td><td>70g</td></tr>
      <tr><td>of which saturates</td><td>2.1g</td><td>4.1g</td><td>20%</td><td>20g</td></tr>
      <tr><td>Carbohydrate</td><td>3.4g</td><td>6.6g</td><td></td><td></td></tr>
      <tr><td>of which sugars</td><td>3.3g</td><td>6.4g</td><td>7%</td><td>90g</td></tr>
      <tr><td>Fibre</td><td>0.5g</td><td>1g</td><td></td><td></td></tr>
      <tr><td>Protein</td><td>20.1g</td><td>39.2g</td><td></td><td></td></tr>
      <tr><td>Salt</td><td>0.54g</td><td>1.05g</td><td>18%</td><td>6g</td></tr>
    </table>`,
  });
  const { product } = extractProductFromHtml(html, 'https://groceries.example/hunters');
  assert.equal(product.name, 'Morrisons Hunters Chicken 430g');
  assert.equal(product.basis.type, 'per_100g');
  assert.equal(product.nutrients.calories.amount, 138);
  assert.equal(product.nutrients.protein.amount, 20.1);
  assert.equal(product.nutrients.carbohydrates.amount, 3.4);
  assert.equal(product.nutrients.fat.amount, 4.8);
  assert.equal(product.nutrients.saturated_fat.amount, 2.1);
  assert.equal(product.nutrients.fibre.amount, 0.5);
  assert.equal(product.nutrients.sugars.amount, 3.3);
  assert.equal(product.nutrients.salt.amount, 0.54);
  assert.equal(product.nutrients.sodium, null);
  assert.equal(product.serving.label, '1/2 pack (195 g)');
  assert.equal(product.serving.nutrients.calories.amount, 269);
  const eaten = consumedFromSnapshot(product, 195, 'g');
  assert.equal(eaten.nutrients.calories.amount, 269.1);
  assert.equal(eaten.nutrients.protein.amount, 39.195);
  assert.equal(eaten.nutrients.carbohydrates.amount, 6.63);
  assert.equal(eaten.nutrients.fat.amount, 9.36);
  assert.equal(eaten.nutrients.saturated_fat.amount, 4.095);
  assert.equal(eaten.nutrients.fibre.amount, 0.975);
  assert.equal(eaten.nutrients.sugars.amount, 6.435);
  assert.equal(eaten.nutrients.salt.amount, 1.053);
  assert.equal(eaten.nutrients.sodium, null);
  const half = consumedFromSnapshot(product, 1, 'serving');
  assert.equal(half.nutrients.calories.amount, 269);
  assert.equal(half.nutrients.protein.amount, 39.2);
});

test('reads a multivitamin tablet table when calories and carbohydrates are absent', () => {
  const html = groceryPage({
    name: 'Morrisons A-Z Multi Vitamins',
    size: '60 per pack',
    table: `<table>
      <tr><th>Typical Values</th><th>Each tablet provides</th><th>% Adult RI</th></tr>
      <tr><td>Vitamin A</td><td>800µg RE</td><td>100</td></tr>
      <tr><td>Vitamin D₃</td><td>5µg</td><td>100</td></tr>
      <tr><td>Vitamin E</td><td>12mg α-TE</td><td>100</td></tr>
      <tr><td>Vitamin K</td><td>75µg</td><td>100</td></tr>
      <tr><td>Vitamin C</td><td>80mg</td><td>100</td></tr>
      <tr><td>Thiamin (Vitamin B1)</td><td>1.1mg</td><td>100</td></tr>
      <tr><td>Riboflavin (Vitamin B2)</td><td>1.4mg</td><td>100</td></tr>
      <tr><td>Niacin</td><td>16mg NE</td><td>100</td></tr>
      <tr><td>Vitamin B6</td><td>1.4mg</td><td>100</td></tr>
      <tr><td>Folic acid</td><td>200µg</td><td>100</td></tr>
      <tr><td>Vitamin B12</td><td>2.5µg</td><td>100</td></tr>
      <tr><td>Biotin</td><td>50µg</td><td>100</td></tr>
      <tr><td>Pantothenic acid</td><td>6mg</td><td>100</td></tr>
      <tr><td>Calcium</td><td>240mg</td><td>30</td></tr>
      <tr><td>Magnesium</td><td>120mg</td><td>32</td></tr>
      <tr><td>Iron</td><td>14mg</td><td>100</td></tr>
      <tr><td>Zinc</td><td>10mg</td><td>100</td></tr>
      <tr><td>Copper</td><td>1mg</td><td>100</td></tr>
      <tr><td>Manganese</td><td>2mg</td><td>100</td></tr>
      <tr><td>Selenium</td><td>55µg</td><td>100</td></tr>
      <tr><td>Chromium</td><td>40µg</td><td>100</td></tr>
      <tr><td>Molybdenum</td><td>50µg</td><td>100</td></tr>
      <tr><td>Iodine</td><td>150µg</td><td>100</td></tr>
    </table>`,
  });
  const { product } = extractProductFromHtml(html, 'https://groceries.morrisons.com/products/morrisons-a-z-multi-vitamins/108615040');
  assert.equal(product.basis.type, 'per_serving');
  assert.equal(product.nutrients.calories, null);
  assert.equal(product.nutrients.carbohydrates, null);
  assert.equal(product.nutrients.protein, null);
  assert.equal(product.nutrients.fat, null);
  assert.equal(product.nutrients.vitamin_a.amount, 800);
  assert.equal(product.nutrients.vitamin_d.amount, 5);
  assert.equal(product.nutrients.vitamin_c.amount, 80);
  assert.equal(product.nutrients.vitamin_b12.amount, 2.5);
  assert.equal(product.nutrients.calcium.amount, 240);
  assert.equal(product.nutrients.iron.amount, 14);
  const extras = Object.fromEntries(product.extras.map((item) => [item.key, item.amount]));
  assert.equal(extras.vitamin_k, 75);
  assert.equal(extras.vitamin_b1, 1.1);
  assert.equal(extras.biotin, 50);
  assert.equal(extras.pantothenic_acid, 6);
  assert.equal(extras.chromium, 40);
  assert.equal(extras.molybdenum, 50);
  const eaten = consumedFromSnapshot(product, 1, 'serving');
  assert.equal(eaten.nutrients.calories, null);
  assert.equal(eaten.nutrients.carbohydrates, null);
  assert.equal(eaten.nutrients.vitamin_c.amount, 80);
});

test('keeps a per pack column as one serving instead of treating it as per 100 g', () => {
  const html = groceryPage({
    name: 'Morrisons Chicken Tikka Masala & Rice',
    size: '400g',
    table: `<table>
      <tr><th>Typical Values</th><th>(Microwaved) per 100g</th><th>(Microwaved) per pack</th><th>%RI</th><th>your RI*</th></tr>
      <tr><td>Energy</td><td>629kJ/150kcal</td><td>2378kJ/566kcal</td><td>28%</td><td>8400kJ/2000kcal</td></tr>
      <tr><td>Fat</td><td>5.1g</td><td>19.3g</td><td>28%</td><td>70g</td></tr>
      <tr><td>of which saturates</td><td>1.5g</td><td>5.7g</td><td>28%</td><td>20g</td></tr>
      <tr><td>Carbohydrate</td><td>17.7g</td><td>66.9g</td><td></td><td></td></tr>
      <tr><td>of which sugars</td><td>3.1g</td><td>11.7g</td><td>13%</td><td>90g</td></tr>
      <tr><td>Fibre</td><td>1.1g</td><td>4.2g</td><td></td><td></td></tr>
      <tr><td>Protein</td><td>7.7g</td><td>29.1g</td><td></td><td></td></tr>
      <tr><td>Salt</td><td>0.48g</td><td>1.81g</td><td>30%</td><td>6g</td></tr>
    </table>`,
  });
  const { product } = extractProductFromHtml(html, 'https://groceries.example/tikka');
  assert.equal(product.basis.type, 'per_100g');
  assert.equal(product.nutrients.calories.amount, 150);
  assert.equal(product.serving.label, '1 pack');
  assert.equal(product.serving.unit, 'product');
  const pack = consumedFromSnapshot(product, 1, 'serving');
  assert.equal(pack.nutrients.calories.amount, 566);
  assert.equal(pack.nutrients.protein.amount, 29.1);
  assert.equal(pack.nutrients.carbohydrates.amount, 66.9);
  assert.equal(pack.nutrients.fat.amount, 19.3);
  assert.equal(pack.nutrients.saturated_fat.amount, 5.7);
  assert.equal(pack.nutrients.fibre.amount, 4.2);
  assert.equal(pack.nutrients.sugars.amount, 11.7);
  assert.equal(pack.nutrients.salt.amount, 1.81);
  assert.equal(pack.nutrients.sodium, null);
  const soldWeight = consumedFromSnapshot(product, 400, 'g');
  assert.equal(soldWeight.nutrients.calories.amount, 600);
});
