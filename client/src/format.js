import { formatNumber } from '@shared/nutrients.js';

export function formatDay(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

export function shortDay(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(year, month - 1, day));
}

export function sourceLabel(provenance) {
  if (provenance?.provider === 'openfoodfacts') return 'Open Food Facts';
  if (provenance?.provider === 'page_structured') return 'Product page';
  if (provenance?.provider === 'ai') return 'AI extraction';
  return 'Entered manually';
}

export function confidenceLabel(provenance) {
  if (provenance?.confidence === 'verified') return 'Verified database';
  if (provenance?.confidence === 'extracted') return 'Extracted from the source';
  return 'Entered by you';
}

export function quantityLabel(quantity, unit) {
  const number = formatNumber(quantity, unit === 'g' || unit === 'ml' ? 'g' : 'kcal');
  if (unit === 'serving') return `${number} ${quantity === 1 ? 'serving' : 'servings'}`;
  if (unit === 'product') return `${number} ${quantity === 1 ? 'product' : 'products'}`;
  return `${number} ${unit}`;
}
