import { useEffect, useState } from 'react';
import { GOAL_KEYS, NUTRIENT_DEFS, formatNumber, shiftDate, todayISO } from '@shared/nutrients.js';
import { api } from '../api.js';
import { confidenceLabel, formatDay, quantityLabel, shortDay, sourceLabel } from '../format.js';
import { NutrientTable } from './NutrientTable.jsx';
import { ThemeSettings } from './ThemeSettings.jsx';

const MACROS = ['protein', 'carbohydrates', 'fat', 'fibre'];
const MACRO_LABELS = {
  protein: 'Protein',
  carbohydrates: 'Carbs',
  fat: 'Fat',
  fibre: 'Fibre',
};

function shownAmount(total, entryCount) {
  if (entryCount === 0) return 0;
  return total?.amount ?? null;
}

export function Dashboard({ user, date, day, notice, error, ai, onAi, onDate, onDay, onNotice, onLogout, onAdd, onAnalytics }) {
  const isToday = date === todayISO();
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="34" height="34">
              <rect width="32" height="32" rx="10" fill="currentColor" />
              <path d="M8 20.5c2.2-4.8 4.2-7.2 8-7.2s5.8 2.4 8 7.2" fill="none" stroke="var(--on-accent)" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <p className="eyebrow">FitCalorie</p>
            <strong className="who">{user.email}</strong>
          </div>
        </div>
        <div className="row">
          <ThemeSettings />
          <button type="button" onClick={onAnalytics}>Analytics</button>
          <button type="button" className="primary" onClick={onAdd}><span aria-hidden="true">+</span> Add food</button>
          <button type="button" className="ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <div className="layout">
        <aside>
          <DateNav date={date} isToday={isToday} onDate={onDate} />
          <History history={day?.history || []} date={date} onDate={onDate} />
          {day && <Goals date={date} onDay={onDay} onNotice={onNotice} goals={day.goals} goalDetails={day.goalDetails} />}
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
            </>
          )}
          <ApiKeyPanel ai={ai} onAi={onAi} />
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
  const peak = Math.max(1, ...history.map((item) => Number(item.calories) || 0));
  return (
    <section className="panel">
      <h2>Previous days</h2>
      {history.length === 0 && <p className="hint">Nothing has been logged yet.</p>}
      <ul className="history">
        {history.map((item) => (
          <li key={item.date}>
            <button type="button" aria-current={item.date === date ? 'date' : undefined} onClick={() => onDate(item.date)}>
              <span className="history-fill" style={{ width: `${((Number(item.calories) || 0) / peak) * 100}%` }} aria-hidden="true" />
              <span>{shortDay(item.date)}</span>
              <strong>{item.calories == null ? '—' : `${formatNumber(item.calories, 'kcal')} kcal`}</strong>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Goals({ date, goals, goalDetails, onDay, onNotice }) {
  const [values, setValues] = useState(() => fromGoals(goals));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setValues(fromGoals(goals)), [goals]);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const targets = {};
    const specs = {};
    for (const [key, detail] of Object.entries(goalDetails || {})) {
      if (!detail || GOAL_KEYS.includes(key)) continue;
      specs[key] = { kind: detail.kind, amount: detail.amount, min: detail.min, max: detail.max };
      targets[key] = detail.kind === 'range' ? null : detail.amount;
    }
    for (const key of GOAL_KEYS) {
      const raw = String(values[key] ?? '').trim();
      const existing = goalDetails?.[key];
      if (existing?.kind === 'range' && raw === '') {
        specs[key] = { kind: 'range', min: existing.min, max: existing.max };
        targets[key] = null;
        continue;
      }
      targets[key] = raw === '' ? null : Number(raw);
      if (existing?.kind && existing.kind !== 'range' && targets[key] != null) {
        specs[key] = { kind: existing.kind, amount: targets[key] };
      }
    }
    try {
      await api('/api/goals', { method: 'PUT', body: { targets, specs } });
      onDay(await api(`/api/days/${date}`));
      onNotice(date === todayISO()
        ? 'Goals saved.'
        : 'Goals saved from today onward. This day still uses the earlier goal.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Daily goals</h2>
      <p className="hint">A saved goal applies from today onward. Earlier days keep the goal that was already in effect. Salt, sugar, water, and the other analytics targets are edited on the Analytics page and kept when you save here.</p>
      {GOAL_KEYS.some((key) => goalDetails?.[key]?.kind === 'range') && (
        <p className="hint">A range is set for {GOAL_KEYS.filter((key) => goalDetails?.[key]?.kind === 'range').map((key) => NUTRIENT_DEFS.find((item) => item.key === key)?.label).join(', ')}. Leave the field blank to keep that range, or type a single number to replace it.</p>
      )}
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
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save goals'}</button>
      </form>
    </section>
  );
}

function fromGoals(goals) {
  return Object.fromEntries(GOAL_KEYS.map((key) => [key, goals?.[key] ?? '']));
}

function apiKeyMessage(ai) {
  if (ai?.source === 'account') return 'API key saved. It is used when a website is missing nutrients.';
  if (ai?.configured) return 'An API key is already set on the server. Add your own to use it for this account instead.';
  return 'If a website is missing some nutrients, please add an API key.';
}

function ApiKeyPanel({ ai, onAi }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const account = ai?.source === 'account';

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const data = await api('/api/settings/ai', { method: 'PUT', body: { apiKey: value.trim() } });
      setValue('');
      setSaved(true);
      onAi(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Are you sure you want to delete the API key?')) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      onAi(await api('/api/settings/ai', { method: 'DELETE' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>API key</h2>
      <p className="hint">{apiKeyMessage(ai)}</p>
      <form onSubmit={save} className="stack">
        <label>
          API key
          <input
            type="password"
            name="openai-api-key"
            autoComplete="off"
            spellCheck="false"
            maxLength={400}
            value={value}
            placeholder={account ? 'Paste a new key to replace it' : 'Paste your API key'}
            onChange={(event) => { setValue(event.target.value); setSaved(false); }}
            required
          />
        </label>
        {error && <p className="banner error" role="alert">{error}</p>}
        {saved && <p className="banner success" role="status">API key saved.</p>}
        <button className="primary" type="submit" disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Save API key'}</button>
        {account && <button type="button" onClick={remove} disabled={busy}>Remove API key</button>}
      </form>
    </section>
  );
}

function Hero({ day, isToday }) {
  const amount = shownAmount(day.totals.calories, day.entryCount);
  const goal = day.goals.calories;
  const caloriesKnown = amount != null;
  const ratio = goal && caloriesKnown ? amount / goal : null;
  const missingCalories = day.entryCount > 0 && !caloriesKnown;
  return (
    <section className="hero">
      <div className="hero-copy">
        <p className="eyebrow">{isToday ? 'Today' : 'Selected day'}</p>
        <h1>{formatDay(day.date)}</h1>
        <p className="calorie-figure">
          <strong>{amount == null ? '—' : formatNumber(amount, 'kcal')}</strong>
          <span>kcal</span>
        </p>
        {!goal && <p className="hint">Set a calorie goal to see how this day compares.</p>}
        {goal && caloriesKnown && (
          <p>{formatNumber(goal, 'kcal')} kcal goal · {ratio > 1 ? `${formatNumber(amount - goal, 'kcal')} over` : `${formatNumber(goal - amount, 'kcal')} left`}</p>
        )}
        {goal && missingCalories && <p>{formatNumber(goal, 'kcal')} kcal goal · calories were not stated</p>}
        {!goal && missingCalories && <p className="hint">Calories were not stated for the food logged on this day.</p>}
        {day.totals.calories.partial && <p className="hint">Calories are missing from {day.totals.calories.missing} item{day.totals.calories.missing === 1 ? '' : 's'}.</p>}
      </div>
      <CalorieRing ratio={ratio} emptyLabel={goal && missingCalories ? 'Not stated' : 'No goal'} />
    </section>
  );
}

function CalorieRing({ ratio, emptyLabel }) {
  const size = 156;
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const hasGoal = ratio != null;
  const clamped = hasGoal ? Math.min(ratio, 1) : 0;
  const over = hasGoal && ratio > 1;
  const percent = hasGoal ? Math.round(ratio * 100) : null;
  return (
    <div className={over ? 'ring-wrap is-over' : 'ring-wrap'}>
      <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
        {hasGoal && (
          <circle
            className="ring-fill"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circ * clamped} ${circ}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <p className="ring-label">
        <strong>{percent == null ? '—' : `${percent}%`}</strong>
        <span>{percent == null ? emptyLabel : over ? 'Over goal' : 'Of goal'}</span>
      </p>
    </div>
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
          <article key={key} data-macro={key}>
            <div className="macro-head">
              <h2>{MACRO_LABELS[key]}</h2>
              {ratio != null && <span className="macro-pct">{Math.round(ratio * 100)}%</span>}
            </div>
            <p className={amount == null ? 'macro-value is-empty' : 'macro-value'}>{amount == null ? 'Not recorded' : `${formatNumber(amount, def.unit)} ${def.unit}`}</p>
            {ratio != null && (
              <>
                <div className="meter" aria-hidden="true"><span style={{ width: `${Math.min(ratio, 1) * 100}%` }} data-over={ratio > 1 ? 'true' : 'false'} /></div>
                <p className="hint">Goal {formatNumber(goal, def.unit)} {def.unit}</p>
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
  const defs = NUTRIENT_DEFS.filter((def) => def.group === 'micro' || ['saturated_fat', 'unsaturated_fat', 'monounsaturated_fat', 'polyunsaturated_fat', 'sugars', 'added_sugars'].includes(def.key));
  const rows = defs.map((def) => {
    const total = day.totals[def.key];
    const amount = day.entryCount === 0 ? null : total?.amount ?? null;
    return { def, total, amount };
  });
  const recorded = rows.filter((row) => row.amount != null);
  const missing = rows.filter((row) => row.amount == null);
  return (
    <section className="panel">
      <h2>Other nutrients</h2>
      {recorded.length === 0 && day.extras.length === 0 && <p className="hint">None of these were listed on this day’s foods.</p>}
      {(recorded.length > 0 || day.extras.length > 0) && (
        <ul className="micro-grid">
          {recorded.map(({ def, total, amount }) => (
            <li key={def.key}>
              <span>{def.label}</span>
              <strong>{formatNumber(amount, def.unit)} {def.unit}</strong>
              {total.partial && <em>Missing from {total.missing}</em>}
            </li>
          ))}
          {day.extras.map((item) => (
            <li key={`${item.key}-${item.unit}`}>
              <span>{item.label}</span>
              <strong>{formatNumber(item.amount, item.unit)} {item.unit}</strong>
              {item.partial && <em>Not on every item</em>}
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <p className="missing">Not provided: {missing.map((row) => row.def.label).join(', ')}. Empty values were not treated as zero.</p>
      )}
    </section>
  );
}

function EntryList({ day, onDay, onNotice }) {
  return (
    <section className="panel">
      <h2>Food log</h2>
      {day.entries.length === 0 && <p className="empty">Nothing logged for this day.</p>}
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
          <p className="entry-meta">{quantityLabel(entry.quantity, entry.quantityUnit)} · {entry.snapshot.basis.label}</p>
          <p className="badges">
            <span>{sourceLabel(entry.provenance)}</span>
            <span>{confidenceLabel(entry.provenance)}</span>
          </p>
        </div>
        <div className="entry-side">
          <p className="entry-kcal">
            <strong>{entry.calories?.amount == null ? '—' : formatNumber(entry.calories.amount, 'kcal')}</strong>
            <span>kcal</span>
          </p>
          <div className="row">
            <button type="button" aria-label={`Edit ${entry.name}`} onClick={() => { setEditing((open) => !open); setError(''); }}>Edit</button>
            <button type="button" aria-label={`Delete ${entry.name}`} onClick={remove} disabled={busy}>Delete</button>
          </div>
        </div>
      </div>
      <p className="macro-line">
        {['protein', 'carbohydrates', 'fat', 'fibre'].map((key) => {
          const def = NUTRIENT_DEFS.find((item) => item.key === key);
          const value = entry.nutrients[key];
          return <span key={key} data-macro={key}>{def.label} {value ? `${formatNumber(value.amount, value.unit)} ${value.unit}` : 'not recorded'}</span>;
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
