import assert from 'node:assert/strict';
import test from 'node:test';
import {
  basisFromType,
  consumedFromSnapshot,
  convertUnit,
  sanitizeNutrientMap,
  sumNutrientMaps,
} from '../shared/nutrients.js';

test('scales the specification example from per 100 g to 150 g', () => {
  const snapshot = {
    basis: basisFromType('per_100g'),
    nutrients: sanitizeNutrientMap({
      calories: { amount: 250, unit: 'kcal' },
      protein: { amount: 10, unit: 'g' },
      carbohydrates: { amount: 30, unit: 'g' },
      fat: { amount: 8, unit: 'g' },
      fibre: { amount: 4, unit: 'g' },
      sodium: { amount: 100, unit: 'mg' },
      iron: { amount: 0, unit: 'mg' },
    }),
    extras: [{ key: 'cholesterol', label: 'Cholesterol', unit: 'mg', amount: 20 }],
    serving: null,
  };
  const eaten = consumedFromSnapshot(snapshot, 150, 'g');
  assert.equal(eaten.factor, 1.5);
  assert.equal(eaten.nutrients.calories.amount, 375);
  assert.equal(eaten.nutrients.protein.amount, 15);
  assert.equal(eaten.nutrients.carbohydrates.amount, 45);
  assert.equal(eaten.nutrients.fat.amount, 12);
  assert.equal(eaten.nutrients.fibre.amount, 6);
  assert.equal(eaten.nutrients.sodium.amount, 150);
  assert.equal(eaten.nutrients.iron.amount, 0);
  assert.equal(eaten.nutrients.vitamin_c, null);
  assert.equal(eaten.extras[0].amount, 30);
});

test('keeps a missing nutrient null and a stated zero as zero when totals are combined', () => {
  const first = sanitizeNutrientMap({
    calories: { amount: 375, unit: 'kcal' },
    protein: { amount: 15, unit: 'g' },
    iron: { amount: 0, unit: 'mg' },
  });
  const second = sanitizeNutrientMap({
    calories: { amount: 100, unit: 'kcal' },
  });
  const totals = sumNutrientMaps([first, second]);
  assert.equal(totals.calories.amount, 475);
  assert.equal(totals.protein.amount, 15);
  assert.equal(totals.protein.partial, true);
  assert.equal(totals.iron.amount, 0);
  assert.equal(totals.iron.partial, true);
  assert.equal(totals.vitamin_c.amount, null);
  assert.equal(totals.carbohydrates.amount, null);
});

test('scales a per-serving value when the product has no separate serving block', () => {
  const consumed = consumedFromSnapshot({
    basis: basisFromType('per_serving'),
    nutrients: sanitizeNutrientMap({ calories: { amount: 269, unit: 'kcal' }, sodium: null }),
    extras: [],
    serving: null,
  }, 2, 'serving');
  assert.equal(consumed.nutrients.calories.amount, 538);
  assert.equal(consumed.nutrients.sodium, null);
});

test('does not convert between incompatible units', () => {
  assert.equal(convertUnit(0.0428, 'g', 'mg'), 42.8);
  assert.equal(convertUnit(0.028, 'g', 'mg'), 28);
  assert.equal(convertUnit(2252, 'kJ', 'kcal') > 538 && convertUnit(2252, 'kJ', 'kcal') < 539, true);
  assert.equal(convertUnit(10, 'ml', 'g'), null);
  assert.throws(() => consumedFromSnapshot({
    basis: basisFromType('per_100g'),
    nutrients: sanitizeNutrientMap({ calories: { amount: 100, unit: 'kcal' } }),
    extras: [],
    serving: null,
  }, 1, 'ml'), /in g/);
});
