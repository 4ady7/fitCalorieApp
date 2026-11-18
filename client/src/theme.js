export const THEME_KEY = 'fitcalorie-theme';

export const THEMES = [
  {
    id: 'harbor',
    name: 'Harbor',
    description: 'Cool teal on mist. Quiet contrast, easy for long reading.',
    swatches: ['#e7f1f2', '#0e6b74', '#b47b1e', '#c45c3a'],
    icon: ['#0e6b74', '#f3fbfb'],
  },
  {
    id: 'orchard',
    name: 'Orchard',
    description: 'Berry, apricot, and olive on a warm page.',
    swatches: ['#f6efe9', '#7a3050', '#b5812a', '#c45b2a'],
    icon: ['#7a3050', '#fff7f8'],
  },
  {
    id: 'north',
    name: 'North',
    description: 'Clear blue on cool gray. The highest separation between type and page.',
    swatches: ['#eef2f7', '#1d4e89', '#b58100', '#d3542c'],
    icon: ['#1d4e89', '#f5f9ff'],
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Terracotta on warm clay, with green kept for fibre.',
    swatches: ['#f7f0e8', '#9a3818', '#a56b12', '#3f6b45'],
    icon: ['#9a3818', '#fff6f1'],
  },
  {
    id: 'ink',
    name: 'Ink',
    description: 'Near-black type on stone. Color is used only for the nutrients.',
    swatches: ['#f3f2ef', '#222222', '#8a6230', '#c4461a'],
    icon: ['#222222', '#f7f6f3'],
  },
];

const THEME_IDS = new Set(THEMES.map((theme) => theme.id));

export function normalizeTheme(value) {
  return THEME_IDS.has(value) ? value : 'harbor';
}

export function readTheme() {
  try {
    return normalizeTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return 'harbor';
  }
}

function faviconHref(fill, stroke) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${fill}"/><path d="M8 20.5c2.2-4.8 4.2-7.2 8-7.2s5.8 2.4 8 7.2" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function applyTheme(value) {
  const id = normalizeTheme(value);
  document.documentElement.dataset.theme = id;
  const theme = THEMES.find((item) => item.id === id);
  const icon = document.querySelector('link[rel="icon"]');
  if (icon && theme) icon.href = faviconHref(theme.icon[0], theme.icon[1]);
  return id;
}

export function saveTheme(value) {
  const id = applyTheme(value);
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // The choice still applies for this visit when storage is blocked.
  }
  return id;
}
