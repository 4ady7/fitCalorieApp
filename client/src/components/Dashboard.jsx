import { useEffect, useState } from 'react';
import { GOAL_KEYS, NUTRIENT_DEFS, formatNumber, shiftDate, todayISO } from '@shared/nutrients.js';
import { api } from '../api.js';
import { confidenceLabel, formatDay, quantityLabel, shortDay, sourceLabel } from '../format.js';
import { NutrientTable } from './NutrientTable.jsx';

const MACROS = ['protein', 'carbohydrates', 'fat', 'fibre'];

function shownAmount(total, entryCount) {
  if (entryCount === 0) return 0;
  return total?.amount ?? null;
}

export function Dashboard({ user, date, day, notice, error, aiConfigured, onDate, onDay, onNotice, onLogout, onAdd }) {
  const isToday = date === todayISO();
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">FitCalorie</p>
          <strong>{user.email}</strong>
        </div>
        <div className="row">
          <button type="button" className="primary" onClick={onAdd}>Add food</button>
          <button type="button" className="ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <div className="layout">
        <aside>
          <DateNav date={date} isToday={isToday} onDate={onDate} />
          <History history={day?.history || []} date={date} onDate={onDate} />
          {day && <Goals goals={day.goals} onSaved={(goals) => onDay({ ...day, goals })} onNotice={onNotice} />}
        </aside>
        <main>
          {notice && <p className="banner success" role="status">{notice}</p>}
          {error && <p className="banner error" role="alert">{error}</p>}
          {!day && !error && <p className="banner">Loading this day…</p>}
          {day && (
            <>
              <Hero day={day} isToday={isToday} />
              <MacroGrid day={day} />
              <Micros day={day} />
              <EntryList day={day} onDay={onDay} onNotice={onNotice} />
              {!aiConfigured && (
                <p className="hint">AI extraction is off until an API key is set on the server. Barcodes and nutrition tables still work, and missing nutrients stay blank.</p>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function DateNav({ date, isToday, onDate }) {
  return (
    <section className="panel">
      <h2>Date</h2>
      <div className="date-nav">
        <button type="button" onClick={() => onDate(shiftDate(date, -1))} aria-label="Previous day">←</button>
        <input type="date" value={date} onChange={(event) => event.target.value && onDate(event.target.value)} aria-label="Log date" />
        <button type="button" onClick={() => onDate(shiftDate(date, 1))} aria-label="Next day">→</button>
      </div>
      <p>{formatDay(date)}</p>
      {!isToday && <button type="button" className="ghost" onClick={() => onDate(todayISO())}>Back to today</button>}
    </section>
  );
}

function History({ history, date, onDate }) {
  return (
    <section className="panel">
      <h2>Previous days</h2>
      {history.length === 0 && <p className="hint">Nothing has been logged yet.</p>}
      <ul className="history">
        {history.map((item) => (
          <li key={item.date}>
            <button type="button" aria-current={item.date === date ? 'date' : undefined} onClick={() => onDate(item.date)}>
              <span>{shortDay(item.date)}</span>
              <strong>{formatNumber(item.calories, 'kcal')} kcal</strong>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Goals({ goals, onSaved, onNotice }) {
  const [values, setValues] = useState(() => fromGoals(goals));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setValues(fromGoals(goals)), [goals]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const targets = {};
    for (const key of GOAL_KEYS) {
      const raw = String(values[key]).trim();
      targets[key] = raw === '' ? null : Number(raw);
    }
    try {
      const data = await api('/api/goals', { method: 'PUT', body: { targets } });
      onSaved(data.goals);
      onNotice('Goals saved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Daily goals</h2>
      <form onSubmit={save} className="stack">
        {GOAL_KEYS.map((key) => {
          const def = NUTRIENT_DEFS.find((item) => item.key === key);
          return (
            <label key={key}>
              {def.label} ({def.unit})
              <input inputMode="decimal" value={values[key]} placeholder="None" onChange={(event) => setValues({ ...values, [key]: event.target.value })} />
            </label>
          );
        })}
        {error && <p className="banner error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save goals'}</button>
      </form>
    </section>
  );
}

function fromGoals(goals) {
  return Object.fromEntries(GOAL_KEYS.map((key) => [key, goals?.[key] ?? '']));
}

function Hero({ day, isToday }) {
  const amount = shownAmount(day.totals.calories, day.entryCount);
  const goal = day.goals.calories;
  const ratio = goal && amount != null ? amount / goal : null;
  return (
    <section className="hero">
      <p className="eyebrow">{isToday ? 'Today' : 'Selected day'}</p>
      <h1>{formatDay(day.date)}</h1>
      <p className="calorie-figure">
        <strong>{amount == null ? '—' : formatNumber(amount, 'kcal')}</strong>
        <span>kcal</span>
      </p>
      {ratio == null && <p>No calorie goal yet.</p>}
      {ratio != null && (
        <>
          <p>{formatNumber(goal, 'kcal')} kcal goal · {ratio > 1 ? `${formatNumber(amount - goal, 'kcal')} over` : `${formatNumber(goal - amount, 'kcal')} left`}</p>
          <div className="meter" aria-hidden="true">
            <span style={{ width: `${Math.min(ratio, 1) * 100}%` }} data-over={ratio > 1 ? 'true' : 'false'} />
          </div>
          <p className="hint">{Math.round(ratio * 100)}% of the calorie goal</p>
        </>
      )}
      {day.totals.calories.partial && <p className="hint">Calories are missing from {day.totals.calories.missing} item{day.totals.calories.missing === 1 ? '' : 's'}.</p>}
    </section>
  );
}

function MacroGrid({ day }) {
  return (
    <section className="macro-grid" aria-label="Macronutrients">
      {MACROS.map((key) => {
        const def = NUTRIENT_DEFS.find((item) => item.key === key);
        const total = day.totals[key];
        const amount = shownAmount(total, day.entryCount);
        const goal = day.goals[key];
        const ratio = goal && amount != null ? amount / goal : null;
        return (
          <article key={key}>
            <h2>{def.label}</h2>
            <p className="macro-value">{amount == null ? 'Not recorded' : `${formatNumber(amount, def.unit)} ${def.unit}`}</p>
            {ratio != null && (
              <>
                <div className="meter" aria-hidden="true"><span style={{ width: `${Math.min(ratio, 1) * 100}%` }} data-over={ratio > 1 ? 'true' : 'false'} /></div>
                <p className="hint">{Math.round(ratio * 100)}% of {formatNumber(goal, def.unit)} {def.unit}</p>
              </>
            )}
            {amount != null && total.partial && <p className="hint">Missing from {total.missing} item{total.missing === 1 ? '' : 's'}.</p>}
          </article>
        );
      })}
    </section>
  );
}

function Micros({ day }) {
  const defs = NUTRIENT_DEFS.filter((def) => def.group === 'micro' || def.key === 'saturated_fat' || def.key === 'sugars');
  return (
    <section className="panel">
      <h2>Other nutrients</h2>
      <ul className="micro-grid">
        {defs.map((def) => {
          const total = day.totals[def.key];
          const amount = day.entryCount === 0 ? null : total?.amount ?? null;
          return (
            <li key={def.key}>
              <span>{def.label}</span>
              <strong>{amount == null ? 'Not recorded' : `${formatNumber(amount, def.unit)} ${def.unit}`}</strong>
              {amount != null && total.partial && <em>Missing from {total.missing}</em>}
            </li>
          );
        })}
        {day.extras.map((item) => (
          <li key={`${item.key}-${item.unit}`}>
            <span>{item.label}</span>
            <strong>{formatNumber(item.amount, item.unit)} {item.unit}</strong>
            {item.partial && <em>Not on every item</em>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EntryList({ day, onDay, onNotice }) {
  return (
    <section className="panel">
      <h2>Food log</h2>
      {day.entries.length === 0 && <p>Nothing logged for this day.</p>}
      <ul className="entries">
        {day.entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} onDay={onDay} onNotice={onNotice} />
        ))}
      </ul>
    </section>
  );
}

function EntryRow({ entry, onDay, onNotice }) {
  const [editing, setEditing] = useState(false);
  const [quantity, setQuantity] = useState(String(entry.quantity));
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api(`/api/entries/${entry.id}`, {
        method: 'PATCH',
        body: { name, quantity: Number(quantity), quantityUnit: entry.quantityUnit },
      });
      onDay(data.day);
      onNotice(`${name} updated.`);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${entry.name}?`)) return;
    setBusy(true);
    setError('');
    try {
      const data = await api(`/api/entries/${entry.id}`, { method: 'DELETE' });
      onDay(data.day);
      onNotice(`${entry.name} deleted.`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <li>
      <div className="entry-top">
        <div>
          <h3>{entry.name}</h3>
          <p>{quantityLabel(entry.quantity, entry.quantityUnit)} · {formatNumber(entry.calories.amount, 'kcal')} kcal</p>
          <p className="hint">{sourceLabel(entry.provenance)} · {confidenceLabel(entry.provenance)} · {entry.snapshot.basis.label}</p>
        </div>
        <div className="row">
          <button type="button" aria-label={`Edit ${entry.name}`} onClick={() => { setEditing((open) => !open); setError(''); }}>Edit</button>
          <button type="button" aria-label={`Delete ${entry.name}`} onClick={remove} disabled={busy}>Delete</button>
        </div>
      </div>
      <p className="macro-line">
        {['protein', 'carbohydrates', 'fat', 'fibre'].map((key) => {
          const def = NUTRIENT_DEFS.find((item) => item.key === key);
          const value = entry.nutrients[key];
          return <span key={key}>{def.label} {value ? `${formatNumber(value.amount, value.unit)} ${value.unit}` : 'not recorded'}</span>;
        })}
      </p>
      <details>
        <summary>Nutrition breakdown</summary>
        <NutrientTable nutrients={entry.nutrients} extras={entry.extras} />
      </details>
      {editing && (
        <form className="edit-row" onSubmit={save}>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Quantity ({entry.quantityUnit})
            <input type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
          </label>
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </form>
      )}
      {error && <p className="banner error" role="alert">{error}</p>}
    </li>
  );
}
