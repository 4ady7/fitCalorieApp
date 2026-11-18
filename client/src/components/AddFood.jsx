import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import {
  NUTRIENT_DEFS,
  basisFromType,
  consumedFromSnapshot,
  formatNumber,
  servingAvailable,
} from '@shared/nutrients.js';
import { api } from '../api.js';
import { NutrientTable } from './NutrientTable.jsx';

const MANUAL_FIELDS = NUTRIENT_DEFS.filter((def) => ['calories', 'protein', 'carbohydrates', 'fat', 'saturated_fat', 'fibre', 'sugars'].includes(def.key));
const MORE_FIELDS = NUTRIENT_DEFS.filter((def) => !MANUAL_FIELDS.includes(def));

const EMPTY_MANUAL = Object.fromEntries(NUTRIENT_DEFS.map((def) => [def.key, '']));

function basisUnit(type) {
  if (type === 'per_100ml') return 'ml';
  if (type === 'per_serving') return 'serving';
  if (type === 'per_product') return 'product';
  return 'g';
}

function defaultQuantity(product) {
  const unit = product?.basis?.referenceUnit;
  if (unit === 'g' || unit === 'ml') return { quantity: '100', quantityUnit: unit };
  if (unit === 'serving' || unit === 'product') return { quantity: '1', quantityUnit: unit };
  return { quantity: '100', quantityUnit: 'g' };
}

export function AddFood({ date, isToday, aiConfigured, onClose, onAdded }) {
  const [tab, setTab] = useState('barcode');
  const [barcode, setBarcode] = useState('');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [product, setProduct] = useState(null);
  const [reviewToken, setReviewToken] = useState('');
  const [quantity, setQuantity] = useState('100');
  const [quantityUnit, setQuantityUnit] = useState('g');
  const [basisType, setBasisType] = useState('per_100g');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [manual, setManual] = useState(EMPTY_MANUAL);
  const [manualName, setManualName] = useState('');
  const [manualBasis, setManualBasis] = useState('portion');
  const [manualQuantity, setManualQuantity] = useState('1');
  const [manualUnit, setManualUnit] = useState('product');
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const scanLock = useRef(false);
  const submitLock = useRef(false);

  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => () => controlsRef.current?.stop(), []);

  useEffect(() => {
    if (!cameraOn) return undefined;
    let cancelled = false;
    scanLock.current = false;
    const reader = new BrowserMultiFormatReader(undefined, {
      delayBetweenScanAttempts: 200,
      delayBetweenScanSuccess: 700,
    });
    const callback = (result, _err, controls) => {
      if (!result || scanLock.current) return;
      scanLock.current = true;
      controls.stop();
      controlsRef.current = null;
      setCameraOn(false);
      const text = result.getText();
      if (/^https?:\/\//i.test(text)) lookupUrl(text);
      else lookupBarcode(text.replace(/\D/g, '') || text);
    };
    (async () => {
      try {
        let controls;
        try {
          controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, callback);
        } catch {
          controls = await reader.decodeFromConstraints({ video: true }, videoRef.current, callback);
        }
        if (cancelled) controls.stop();
        else controlsRef.current = controls;
      } catch (err) {
        if (!cancelled) {
          setCameraOn(false);
          setError(err?.name === 'NotAllowedError'
            ? 'Camera access was blocked. Enter the barcode or upload a photo instead.'
            : 'The camera could not be started. Enter the barcode or upload a photo instead.');
        }
      }
    })();
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [cameraOn]);

  function resetPreview() {
    setProduct(null);
    setReviewToken('');
    setError('');
  }

  async function lookupBarcode(value) {
    setLoading('Looking up that barcode…');
    setError('');
    setProduct(null);
    try {
      const data = await api('/api/lookup/barcode', { method: 'POST', body: { barcode: value } });
      showProduct(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading('');
    }
  }

  async function lookupUrl(value) {
    setLoading(aiConfigured
      ? 'Reading the product page…'
      : 'Reading the product page for a nutrition table…');
    setError('');
    setProduct(null);
    try {
      const data = await api('/api/lookup/url', { method: 'POST', body: { url: value } });
      showProduct(data);
    } catch (err) {
      setError(err.productName ? `${err.message} Identified page: ${err.productName}.` : err.message);
      if (err.productName) setManualName(err.productName);
    } finally {
      setLoading('');
    }
  }

  function showProduct(data) {
    const next = defaultQuantity(data.product);
    setProduct(data.product);
    setReviewToken(data.reviewToken);
    setQuantity(next.quantity);
    setQuantityUnit(next.quantityUnit);
    setBasisType(data.product.basisOptions?.[0] || 'per_100g');
    setIdempotencyKey(crypto.randomUUID());
    setError('');
  }

  async function onPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setLoading('Reading the barcode image…');
    setError('');
    const objectUrl = URL.createObjectURL(file);
    try {
      const reader = new BrowserMultiFormatReader();
      const result = await reader.decodeFromImageUrl(objectUrl);
      const text = result.getText();
      if (/^https?:\/\//i.test(text)) await lookupUrl(text);
      else await lookupBarcode(text.replace(/\D/g, '') || text);
    } catch {
      setError('No barcode could be read from that image.');
      setLoading('');
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  const preview = useMemo(() => {
    if (!product) return null;
    const snapshot = {
      ...product,
      basis: product.basis || (product.basisOptions?.includes(basisType) ? basisFromType(basisType) : null),
    };
    const amount = Number(quantity);
    try {
      const consumed = consumedFromSnapshot(snapshot, amount, quantityUnit);
      return { consumed, error: '' };
    } catch (err) {
      return { consumed: null, error: err.message };
    }
  }, [product, quantity, quantityUnit, basisType]);

  async function addReviewed(event) {
    event.preventDefault();
    if (submitLock.current || !preview?.consumed) return;
    submitLock.current = true;
    setLoading('Adding to your log…');
    setError('');
    try {
      const data = await api('/api/entries', {
        method: 'POST',
        body: {
          date,
          quantity: Number(quantity),
          quantityUnit,
          idempotencyKey,
          reviewToken,
          ...(product.basis ? {} : { basisType }),
        },
      });
      onAdded(data.day, data.duplicate ? `${product.name} was already added.` : `${product.name} added.`);
    } catch (err) {
      submitLock.current = false;
      setError(err.message);
      setLoading('');
    }
  }

  async function addManual(event) {
    event.preventDefault();
    if (submitLock.current) return;
    const nutrients = {};
    for (const def of NUTRIENT_DEFS) {
      const raw = manual[def.key].trim();
      if (!raw) {
        nutrients[def.key] = null;
        continue;
      }
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0) {
        setError(`${def.label} must be zero or greater, or left empty.`);
        return;
      }
      nutrients[def.key] = { amount, unit: def.unit };
    }
    if (nutrients.calories == null) {
      setError('Enter the calories. Leave every other nutrient empty when you do not know it.');
      return;
    }
    setError('');
    submitLock.current = true;
    setLoading('Adding to your log…');
    const key = idempotencyKey || crypto.randomUUID();
    setIdempotencyKey(key);
    try {
      const data = await api('/api/entries', {
        method: 'POST',
        body: {
          source: 'manual',
          date,
          name: manualName,
          quantity: Number(manualQuantity),
          quantityUnit: manualUnit,
          basisType: manualBasis,
          nutrients,
          idempotencyKey: key,
        },
      });
      onAdded(data.day, data.duplicate ? `${manualName} was already added.` : `${manualName} added.`);
    } catch (err) {
      submitLock.current = false;
      setError(err.message);
      setLoading('');
    }
  }

  const effectiveUnit = product?.basis?.referenceUnit || (product ? basisUnit(basisType) : quantityUnit);
  const units = product
    ? [effectiveUnit, servingAvailable(product) ? 'serving' : null].filter((unit, index, all) => unit && all.indexOf(unit) === index)
    : [];

  return (
    <div className="backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <header className="dialog-head">
          <div>
            <p className="eyebrow">{isToday ? 'Today' : date}</p>
            <h2 id="add-title">Add food</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose}>Close</button>
        </header>

        {!product && (
          <div className="segmented" role="tablist" aria-label="How to add food">
            {[['scan', 'Scan'], ['barcode', 'Barcode'], ['url', 'Link'], ['manual', 'Manual']].map(([id, label]) => (
              <button key={id} type="button" aria-selected={tab === id} onClick={() => { setTab(id); setError(''); setCameraOn(false); }}>{label}</button>
            ))}
          </div>
        )}

        {loading && <p className="banner" role="status">{loading}</p>}
        {error && <p className="banner error" role="alert">{error}</p>}

        {!product && tab === 'scan' && (
          <div className="stack">
            <p>Point the camera at a product barcode. You can also upload a photo of one.</p>
            <div className="viewfinder">
              <video ref={videoRef} muted playsInline />
              {!cameraOn && <span>Camera is off</span>}
            </div>
            <div className="row">
              <button type="button" className="primary" onClick={() => { setError(''); setCameraOn((on) => !on); }}>
                {cameraOn ? 'Stop camera' : 'Start camera'}
              </button>
              <label className="file-button">
                Upload a barcode photo
                <input type="file" accept="image/*" capture="environment" onChange={onPhoto} />
              </label>
            </div>
          </div>
        )}

        {!product && tab === 'barcode' && (
          <form className="stack" onSubmit={(event) => { event.preventDefault(); lookupBarcode(barcode); }}>
            <label>
              Barcode
              <input inputMode="numeric" autoComplete="off" value={barcode} onChange={(event) => setBarcode(event.target.value)} placeholder="8 to 14 digits" required />
            </label>
            <button className="primary" type="submit" disabled={Boolean(loading)}>Look up barcode</button>
          </form>
        )}

        {!product && tab === 'url' && (
          <form className="stack" onSubmit={(event) => { event.preventDefault(); lookupUrl(url); }}>
            <label>
              Product link
              <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" required />
            </label>
            <p className="hint">
              {aiConfigured
                ? 'A nutrition table or structured product data is used first. AI is only asked to copy numbers that are actually written on the page.'
                : 'Nutrition tables and structured product data are read automatically. Set OPENAI_API_KEY on the server to extract numbers from pages that have no table. Missing values are never guessed.'}
            </p>
            <button className="primary" type="submit" disabled={Boolean(loading)}>Look up link</button>
          </form>
        )}

        {!product && tab === 'manual' && (
          <form className="stack" onSubmit={addManual}>
            <label>
              Food name
              <input value={manualName} onChange={(event) => { setManualName(event.target.value); setIdempotencyKey(''); }} required />
            </label>
            <div className="split">
              <label>
                Quantity
                <input type="number" min="0" step="any" value={manualQuantity} onChange={(event) => { setManualQuantity(event.target.value); setIdempotencyKey(''); }} required />
              </label>
              <label>
                Unit
                <select value={manualUnit} onChange={(event) => { setManualUnit(event.target.value); setIdempotencyKey(''); }}>
                  <option value="g">g</option>
                  <option value="ml">ml</option>
                  <option value="serving">serving</option>
                  <option value="product">product</option>
                </select>
              </label>
            </div>
            <label>
              These values apply to
              <select value={manualBasis} onChange={(event) => { setManualBasis(event.target.value); setIdempotencyKey(''); }}>
                <option value="portion">this quantity</option>
                <option value="per_100g">100 g</option>
                <option value="per_100ml">100 ml</option>
                <option value="per_serving">1 serving</option>
              </select>
            </label>
            <div className="fields">
              {MANUAL_FIELDS.map((def) => (
                <label key={def.key}>
                  {def.label} ({def.unit})
                  <input inputMode="decimal" value={manual[def.key]} placeholder={def.key === 'calories' ? 'Required' : 'Unknown'} onChange={(event) => { setManual({ ...manual, [def.key]: event.target.value }); setIdempotencyKey(''); }} required={def.key === 'calories'} />
                </label>
              ))}
            </div>
            <details>
              <summary>More nutrients</summary>
              <div className="fields">
                {MORE_FIELDS.map((def) => (
                  <label key={def.key}>
                    {def.label} ({def.unit})
                    <input inputMode="decimal" value={manual[def.key]} placeholder="Unknown" onChange={(event) => { setManual({ ...manual, [def.key]: event.target.value }); setIdempotencyKey(''); }} />
                  </label>
                ))}
              </div>
            </details>
            <button className="primary" type="submit" disabled={Boolean(loading)}>{isToday ? "Add to today's intake" : `Add to ${date}`}</button>
          </form>
        )}

        {product && (
          <form className="stack" onSubmit={addReviewed}>
            <div className="product-head">
              <div>
                <h3>{product.name}</h3>
                {product.brand && <p>{product.brand}</p>}
                {product.description && <p className="hint">{product.description}</p>}
              </div>
              <button type="button" className="ghost" onClick={resetPreview}>Back</button>
            </div>
            <p className="badges">
              <span>{product.provenance.provider === 'openfoodfacts' ? 'Open Food Facts' : product.provenance.provider === 'ai' ? 'AI extraction' : 'Product page'}</span>
              <span>{product.provenance.confidence === 'verified' ? 'Verified database' : 'Extracted from the source'}</span>
              <span>{product.basis?.label || 'Basis needed'}</span>
            </p>
            {product.provenance.notes?.length > 0 && (
              <ul className="notes">
                {product.provenance.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            )}
            {!product.basis && (
              <label>
                Measurement basis
                <select value={basisType} onChange={(event) => {
                    const next = event.target.value;
                    const unit = basisUnit(next);
                    setBasisType(next);
                    setQuantityUnit(unit);
                    setQuantity(unit === 'g' || unit === 'ml' ? '100' : '1');
                  }}>
                  {product.basisOptions.map((option) => (
                    <option key={option} value={option}>
                      {option === 'per_100g' ? 'per 100 g' : option === 'per_100ml' ? 'per 100 ml' : option === 'per_serving' ? 'per serving' : 'per product'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="split">
              <label>
                Quantity eaten
                <input type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
              </label>
              <label>
                Unit
                <select value={quantityUnit} onChange={(event) => setQuantityUnit(event.target.value)}>
                  {units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                </select>
              </label>
            </div>
            {servingAvailable(product) && quantityUnit !== 'serving' && (
              <button type="button" className="ghost" onClick={() => { setQuantity('1'); setQuantityUnit('serving'); }}>
                Use {product.serving.label}
              </button>
            )}
            {preview?.error && <p className="banner error" role="alert">{preview.error}</p>}
            {preview?.consumed && (
              <>
                <p className="hint">
                  For {formatNumber(Number(quantity), 'g')} {quantityUnit} · {formatNumber(preview.consumed.factor, 'g')} × {preview.consumed.basisLabel}.
                  This is added on top of what is already logged.
                </p>
                <NutrientTable nutrients={preview.consumed.nutrients} extras={preview.consumed.extras} />
              </>
            )}
            <button className="primary" type="submit" disabled={Boolean(loading) || !preview?.consumed}>
              {isToday ? "Add to today's intake" : `Add to ${date}`}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
