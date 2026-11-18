import { HttpError } from './errors.js';
import { assertPublicResolution, parsePublicUrl } from './security.js';
import { fetchOffProduct } from './openfoodfacts.js';
import { extractProductFromHtml } from './extract.js';
import { extractNutritionWithAi } from './ai.js';

const PAGE_USER_AGENT = 'FitCalorie/1.0 (personal nutrition tracker; product page reader)';
const MAX_BYTES = 1_500_000;

export function normalizeBarcode(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (!/^\d{8,14}$/.test(digits)) {
    throw new HttpError(400, 'Enter a barcode of 8 to 14 digits.', 'INVALID_BARCODE');
  }
  return digits;
}

export async function lookupBarcode(code) {
  const barcode = normalizeBarcode(code);
  try {
    return await fetchOffProduct(barcode);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new HttpError(502, 'Open Food Facts took too long to respond. Try again.', 'UPSTREAM_TIMEOUT');
    }
    throw new HttpError(502, 'Open Food Facts could not be reached. Try again in a moment.', 'UPSTREAM_UNAVAILABLE');
  }
}

async function fetchPage(url, redirects = 0) {
  if (redirects > 3) throw new HttpError(422, 'That link redirected too many times.', 'TOO_MANY_REDIRECTS');
  await assertPublicResolution(url);
  let response;
  try {
    response = await fetch(url, {
      redirect: 'manual',
      headers: {
        'user-agent': PAGE_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1',
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new HttpError(422, 'That link took too long to respond.', 'UNREACHABLE');
    }
    throw new HttpError(422, 'That link could not be reached.', 'UNREACHABLE');
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new HttpError(422, 'That link redirected without a destination.', 'BAD_REDIRECT');
    return fetchPage(parsePublicUrl(new URL(location, url).toString()), redirects + 1);
  }
  if (response.status === 404) throw new HttpError(422, 'That product page was not found.', 'PAGE_NOT_FOUND');
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(422, 'That product page refused access.', 'PAGE_FORBIDDEN');
  }
  if (!response.ok) throw new HttpError(422, `That product page returned an error (${response.status}).`, 'PAGE_ERROR');
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (!/html|json|xml|text\/plain/.test(type)) {
    throw new HttpError(422, 'That link is not a product page we can read.', 'UNSUPPORTED_PAGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(422, 'That page had no readable content.', 'EMPTY_PAGE');
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BYTES) {
      await reader.cancel();
      throw new HttpError(422, 'That page is too large to analyse.', 'PAGE_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return { finalUrl: url.toString(), contentType: type, text: Buffer.concat(chunks).toString('utf8') };
}

export async function lookupProductUrl(input) {
  const url = parsePublicUrl(input);
  const page = await fetchPage(url);
  let extracted = { product: null, text: '', title: '' };
  if (page.contentType.includes('json')) {
    extracted = extractProductFromHtml(`<html><body><script type="application/ld+json">${page.text}</script></body></html>`, page.finalUrl);
    if (!extracted.product) {
      try {
        const data = JSON.parse(page.text);
        extracted = extractProductFromHtml(`<html><body><script type="application/ld+json">${JSON.stringify(data)}</script></body></html>`, page.finalUrl);
      } catch {
        extracted = { product: null, text: page.text, title: '' };
      }
    }
  } else {
    extracted = extractProductFromHtml(page.text, page.finalUrl);
  }
  if (extracted.product) return extracted.product;

  const ai = await extractNutritionWithAi({
    sourceText: extracted.text || page.text,
    pageUrl: page.finalUrl,
    hintedName: extracted.title,
  });
  if (!ai.configured) {
    throw new HttpError(
      422,
      'No nutrition table or structured nutrition data was found on this page. AI extraction is not configured, so nothing was estimated.',
      'NUTRITION_UNAVAILABLE',
      { productName: extracted.title || undefined },
    );
  }
  if (!ai.product) {
    throw new HttpError(
      422,
      'No nutritional values on this page could be verified. Nothing was estimated.',
      'NUTRITION_UNAVAILABLE',
      { productName: extracted.title || undefined },
    );
  }
  return ai.product;
}
