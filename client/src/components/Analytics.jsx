import { useEffect, useState } from 'react';
import { ANALYTICS_NUTRIENTS, formatMeasure } from '@shared/analytics.js';
import { GOAL_PROFILES, STATUS_TEXT, profileFor, successNoun } from '@shared/goals.js';
import { todayISO } from '@shared/nutrients.js';
import { api } from '../api.js';
import { formatDay } from '../format.js';
import { AnalyticsChart } from './Charts.jsx';
import { ThemeSettings } from './ThemeSettings.jsx';

const PERIODS = [
  ['day', 'Today vs yesterday'],
  ['week', 'This week vs last week'],
  ['month', 'This month vs last month'],
  ['year', 'This year vs last year'],
];

const GOAL_FIELDS = [
  'calories',
  'protein',
  'carbohydrates',
  'fat',
  'fibre',
  'sugars',
  'added_sugars',
  'salt',
  'saturated_fat',
  'unsaturated_fat',
  'monounsaturated_fat',
  'polyunsaturated_fat',
  'water',
];

const WATER_PRESETS = [150, 250, 330, 500];

function formFromGoal(goal) {
  return Object.fromEntries(GOAL_FIELDS.map((key) => {
    const spec = goal?.[key];
    const profile = profileFor(key);
    return [key, {
      kind: spec?.kind && profile.allowed.includes(spec.kind) ? spec.kind : profile.kind,
      amount: spec?.amount ?? '',
      min: spec?.min ?? '',
      max: spec?.max ?? '',
    }];
  }));
}

export function Analytics({ user, onLogout, onLog, onGoals }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('day');
  const [section, setSection] = useState('overall');
  const [nutrient, setNutrient] = useState('protein');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api(`/api/analytics?asOf=${todayISO()}`)
      .then((data) => {
        if (!cancelled) {
          setReport(data);
          setError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  function refresh() {
    setRevision((value) => value + 1);
  }

  const selected = report?.periods?.[period];

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
          <button type="button" onClick={onLog}>Food log</button>
          <button type="button" className="ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main className="analytics-page">
        <header className="analytics-intro">
          <p className="eyebrow">Nutrition Analytics</p>
          <h1>Progress across nutrients, not only calories.</h1>
          <p className="lede">Comparisons use your logged meals, the targets that applied on each day, and water you record yourself. A missing label stays blank. A day you did not log is not counted as zero.</p>
        </header>
        {error && <p className="banner error" role="alert">{error}</p>}
        {!report && !error && <p className="banner">Loading your history…</p>}
        {report && selected && (
          <>
            <div className="segmented period-switch" role="tablist" aria-label="Comparison period">
              {PERIODS.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={period === id} onClick={() => setPeriod(id)}>{label}</button>
              ))}
            </div>
            <div className="segmented section-switch" role="tablist" aria-label="Analytics section">
              <button type="button" role="tab" aria-selected={section === 'overall'} onClick={() => setSection('overall')}>Overall progress</button>
              <button type="button" role="tab" aria-selected={section === 'nutrient'} onClick={() => setSection('nutrient')}>Individual nutrients</button>
            </div>
            {section === 'overall' ? (
              <Overall period={selected} />
            ) : (
              <NutrientAnalysis
                report={report}
                periodId={period}
                period={selected}
                nutrient={nutrient}
                onNutrient={setNutrient}
                onRefresh={refresh}
              />
            )}
            <GoalEditor goal={report.goal} onSaved={() => { refresh(); onGoals(); }} />
          </>
        )}
      </main>
    </div>
  );
}

function Status({ status }) {
  if (!status || status === 'unlogged') return null;
  return <span className="status" data-status={status}>{STATUS_TEXT[status] || status}</span>;
}

function dayCount(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function achievementLine(side, label) {
  if (!side.evaluatedDays) return `${label}: no comparable days.`;
  const percent = side.achievementPercent != null ? ` (${side.achievementPercent}%)` : '';
  return `${label}: ${side.achievedDays} of ${side.evaluatedDays}${percent}.`;
}

function percentOf(percent, goal) {
  if (percent == null) return null;
  const noun = goal?.kind === 'maximum' ? 'limit' : goal?.kind === 'minimum' ? 'minimum' : 'target';
  return `${percent}% of the ${noun}`;
}

function Measure({ amount, unit, partial, empty = 'Not recorded' }) {
  if (amount == null) return <strong className="is-empty">{empty}</strong>;
  return <strong>{formatMeasure(amount, unit)}{partial ? <em> partial</em> : null}</strong>;
}

function Overall({ period }) {
  const calories = period.overall.calories;
  const change = period.id === 'day' ? calories.totalDelta : calories.averageDelta;
  return (
    <section className="analytics-section">
      <div className="panel">
        <h2>{period.label}</h2>
        <p>{period.overall.summary}</p>
      </div>
      <div className="stat-grid">
        <article>
          <h3>{period.current.label}</h3>
          <Measure amount={calories.current.total} unit="kcal" partial={calories.current.partial} />
          <p>{dayCount(calories.current.loggedDays, 'logged day')} · {dayCount(calories.current.coveredDays, 'day')} with calorie data</p>
          <Status status={calories.current.status} />
          {calories.current.percent != null && <p>{calories.current.percent}% of the calorie target</p>}
          {calories.current.calendarDays > 1 && <p>Average {formatMeasure(calories.current.average, 'kcal')} a recorded day</p>}
        </article>
        <article>
          <h3>{period.previous.label}</h3>
          <Measure amount={calories.previous.total} unit="kcal" partial={calories.previous.partial} />
          <p>{dayCount(calories.previous.loggedDays, 'logged day')} · {dayCount(calories.previous.coveredDays, 'day')} with calorie data</p>
          <Status status={calories.previous.status} />
          {calories.previous.percent != null && <p>{calories.previous.percent}% of the calorie target</p>}
          {calories.previous.calendarDays > 1 && <p>Average {formatMeasure(calories.previous.average, 'kcal')} a recorded day</p>}
        </article>
        <article>
          <h3>Difference</h3>
          <Measure amount={change} unit="kcal" empty="Not comparable" />
          <p>{period.id === 'day' ? 'Change in recorded calories.' : 'Change in the daily average. Totals are not compared when the number of logged days differs.'}</p>
          <p>{formatMeasure(calories.totalDelta, 'kcal')} total · {formatMeasure(calories.averageDelta, 'kcal')} a day</p>
        </article>
        <article>
          <h3>Calorie target</h3>
          <Status status={calories.current.evaluatedDays ? undefined : calories.current.status} />
          <strong>{calories.current.evaluatedDays ? `${calories.current.achievedDays} / ${calories.current.evaluatedDays}` : '—'}</strong>
          <p>{achievementLine(calories.current, 'This period')} {achievementLine(calories.previous, period.previous.label)}</p>
          {calories.current.targetVaries && <p>The target changed during this period. Each day uses the target that was in effect then.</p>}
        </article>
      </div>
      <div className="macro-compare">
        {Object.entries(period.overall.macros).map(([key, macro]) => (
          <article key={key}>
            <h3>{macro.label}</h3>
            <p><span>{period.current.label}</span> <Measure amount={macro.current} unit={macro.unit} partial={macro.currentPartial} /></p>
            <p><span>{period.previous.label}</span> <Measure amount={macro.previous} unit={macro.unit} partial={macro.previousPartial} /></p>
            <p className="hint">Stated on {dayCount(macro.currentCovered, 'day')} for {period.current.label.toLowerCase()} and {dayCount(macro.previousCovered, 'day')} for {period.previous.label.toLowerCase()}.{period.id === 'day' ? '' : ' Figures are daily averages of those days.'}</p>
          </article>
        ))}
      </div>
      <div className="chart-stack">
        <AnalyticsChart chart={period.overall.charts.calories} title={`${period.label}: calories`} />
        <AnalyticsChart chart={period.overall.charts.achievement} title="Days the calorie target was met" />
        <AnalyticsChart chart={period.overall.charts.macros} title={period.id === 'day' ? 'Protein, carbohydrates, fat, and fibre' : 'Average protein, carbohydrates, fat, and fibre'} />
      </div>
    </section>
  );
}

function NutrientAnalysis({ report, periodId, period, nutrient, onNutrient, onRefresh }) {
  const view = report.nutrients[nutrient];
  const comparison = period.nutrients[nutrient];
  const shownChange = periodId === 'day' ? comparison.totalDelta : comparison.averageDelta;
  return (
    <section className="analytics-section">
      <div className="nutrient-switch" role="tablist" aria-label="Nutrient">
        {ANALYTICS_NUTRIENTS.map((item) => (
          <button key={item.key} type="button" role="tab" aria-selected={nutrient === item.key} onClick={() => onNutrient(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="panel">
        <h2>{view.label}</h2>
        <p>{view.note}</p>
        <p className="hint">{view.profile.blurb}</p>
      </div>
      <div className="stat-grid">
        <article>
          <h3>Today</h3>
          <Measure amount={view.today.total} unit={view.unit} partial={view.today.partial} />
          <Status status={view.today.status} />
          {view.today.percent != null && <p>{percentOf(view.today.percent, view.today.goal)}</p>}
          <GoalLine goal={view.today.goal} unit={view.unit} />
        </article>
        <article>
          <h3>Yesterday</h3>
          <Measure amount={view.yesterday.total} unit={view.unit} partial={view.yesterday.partial} />
          <Status status={view.yesterday.status} />
          {view.yesterday.percent != null && <p>{percentOf(view.yesterday.percent, view.yesterday.goal)}</p>}
        </article>
        <AverageCard label="This week" stats={view.averages.week} unit={view.unit} />
        <AverageCard label="This month" stats={view.averages.month} unit={view.unit} />
        <AverageCard label="This year" stats={view.averages.year} unit={view.unit} />
        <article>
          <h3>Highest day</h3>
          {view.extremes.highest ? (
            <>
              <Measure amount={view.extremes.highest.amount} unit={view.unit} partial={view.extremes.highest.partial} />
              <p>{formatDay(view.extremes.highest.date)}</p>
            </>
          ) : <strong className="is-empty">No recorded days</strong>}
        </article>
        <article>
          <h3>Lowest day</h3>
          {view.extremes.lowest ? (
            <>
              <Measure amount={view.extremes.lowest.amount} unit={view.unit} partial={view.extremes.lowest.partial} />
              <p>{formatDay(view.extremes.lowest.date)}</p>
            </>
          ) : <strong className="is-empty">No recorded days</strong>}
        </article>
        <article>
          <h3>{period.label}</h3>
          <Measure amount={shownChange} unit={view.unit} empty="Not comparable" />
          <p>{successNoun(view.profile)}: {comparison.current.evaluatedDays ? `${comparison.current.achievedDays} of ${comparison.current.evaluatedDays}${comparison.current.achievementPercent != null ? ` (${comparison.current.achievementPercent}%)` : ''}` : 'no comparable days'}.</p>
          <p className="hint">{period.previous.label}: {comparison.previous.evaluatedDays ? `${comparison.previous.achievedDays} of ${comparison.previous.evaluatedDays}` : 'no comparable days'}.</p>
        </article>
      </div>
      <div className="panel">
        <h2>Comparison</h2>
        <p>{comparison.summary}</p>
      </div>
      <AnalyticsChart chart={comparison.chart} title={`${view.label}: ${period.label}`} />
      {view.components?.map((component) => (
        <ComponentView key={component.key} component={component} period={period} />
      ))}
      {view.source === 'water' && (
        <WaterLog date={report.asOf} entries={report.waterEntries || []} onRefresh={onRefresh} />
      )}
    </section>
  );
}

function AverageCard({ label, stats, unit }) {
  return (
    <article>
      <h3>{label}</h3>
      <Measure amount={stats.amount} unit={unit} partial={stats.partialDays > 0} />
      <p>{dayCount(stats.coveredDays, 'day')} with data{stats.loggedDays ? ` · ${dayCount(stats.loggedDays, 'day')} logged` : ''}</p>
    </article>
  );
}

function GoalLine({ goal, unit }) {
  if (!goal) return <p className="hint">No target for this day.</p>;
  if (goal.kind === 'range') return <p>Range {formatMeasure(goal.min, unit)} – {formatMeasure(goal.max, unit)}</p>;
  const noun = goal.kind === 'maximum' ? 'Limit' : goal.kind === 'minimum' ? 'Minimum' : 'Target';
  return <p>{noun} {formatMeasure(goal.amount, unit)}</p>;
}

function ComponentView({ component, period }) {
  const comparison = period.nutrients[component.key];
  if (!comparison) return null;
  const anyData = component.today.total != null || component.yesterday.total != null || component.averages.year.coveredDays > 0;
  return (
    <section className="panel component-block">
      <h2>{component.label}</h2>
      <p className="hint">{component.profile.blurb}</p>
      {!anyData && <p>No source has stated {component.label.toLowerCase()}. It is not estimated from another nutrient.</p>}
      {anyData && (
        <>
          <div className="stat-grid compact">
            <article>
              <h3>Today</h3>
              <Measure amount={component.today.total} unit={component.unit} partial={component.today.partial} />
              <Status status={component.today.status} />
            </article>
            <article>
              <h3>Yesterday</h3>
              <Measure amount={component.yesterday.total} unit={component.unit} partial={component.yesterday.partial} />
            </article>
            <AverageCard label="This week" stats={component.averages.week} unit={component.unit} />
            <AverageCard label="This month" stats={component.averages.month} unit={component.unit} />
            <AverageCard label="This year" stats={component.averages.year} unit={component.unit} />
          </div>
          <AnalyticsChart chart={comparison.chart} title={`${component.label}: ${period.label}`} />
        </>
      )}
    </section>
  );
}

function WaterLog({ date, entries, onRefresh }) {
  const [custom, setCustom] = useState('');
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const total = entries.reduce((sum, entry) => sum + entry.amountMl, 0);

  async function run(action) {
    setBusy(true);
    setError('');
    try {
      await action();
      onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Record water for {formatDay(date)}</h2>
      <p className="hint">These entries are plain water for your account on this date. They are stored separately from food, so a drink logged as food is not counted here unless you add it.</p>
      <p>Recorded today: <strong>{entries.length ? formatMeasure(total, 'ml') : 'nothing yet'}</strong></p>
      <div className="water-presets">
        {WATER_PRESETS.map((amount) => (
          <button key={amount} type="button" disabled={busy} onClick={() => run(() => api('/api/water', { method: 'POST', body: { date, amountMl: amount } }))}>
            {amount} ml
          </button>
        ))}
      </div>
      <form className="water-custom" onSubmit={(event) => {
        event.preventDefault();
        const amountMl = Number(custom);
        run(async () => {
          await api('/api/water', { method: 'POST', body: { date, amountMl } });
          setCustom('');
        });
      }}>
        <label>
          Custom amount (ml)
          <input inputMode="decimal" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="e.g. 400" />
        </label>
        <button className="primary" type="submit" disabled={busy || !custom.trim()}>Add water</button>
      </form>
      {error && <p className="banner error" role="alert">{error}</p>}
      <ul className="water-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <form onSubmit={(event) => {
              event.preventDefault();
              const amountMl = Number(drafts[entry.id] ?? entry.amountMl);
              run(() => api(`/api/water/${entry.id}`, { method: 'PATCH', body: { amountMl } }));
            }}>
              <label>
                Amount (ml)
                <input
                  inputMode="decimal"
                  value={drafts[entry.id] ?? entry.amountMl}
                  onChange={(event) => setDrafts({ ...drafts, [entry.id]: event.target.value })}
                />
              </label>
              <button type="submit" disabled={busy}>Save</button>
              <button type="button" aria-label={`Delete ${entry.amountMl} ml water entry`} disabled={busy} onClick={() => run(() => api(`/api/water/${entry.id}`, { method: 'DELETE' }))}>Delete</button>
            </form>
          </li>
        ))}
      </ul>
      {entries.length === 0 && <p className="empty">No water recorded for this day.</p>}
    </section>
  );
}

function GoalEditor({ goal, onSaved }) {
  const [form, setForm] = useState(() => formFromGoal(goal));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(formFromGoal(goal)), [goal]);

  function update(key, patch) {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    const targets = {};
    const specs = {};
    for (const key of GOAL_FIELDS) {
      const field = form[key];
      const profile = profileFor(key);
      const kind = profile.allowed.includes(field.kind) ? field.kind : profile.kind;
      if (kind === 'range') {
        specs[key] = {
          kind,
          min: String(field.min).trim() === '' ? null : Number(field.min),
          max: String(field.max).trim() === '' ? null : Number(field.max),
        };
        targets[key] = null;
        continue;
      }
      const raw = String(field.amount).trim();
      const amount = raw === '' ? null : Number(raw);
      targets[key] = amount;
      if (amount != null) specs[key] = { kind, amount };
    }
    for (const [key, spec] of Object.entries(goal || {})) {
      if (GOAL_FIELDS.includes(key) || !spec) continue;
      specs[key] = spec;
      if (spec.amount != null) targets[key] = spec.amount;
    }
    try {
      await api('/api/goals', { method: 'PUT', body: { effectiveDate: todayISO(), targets, specs } });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="panel goal-editor">
      <summary>Targets and limits</summary>
      <p className="hint">Targets apply from today onward. Earlier days keep the target that was already in effect. Nothing here is a universal recommendation.</p>
      <form onSubmit={save} className="goal-grid">
        {GOAL_FIELDS.map((key) => {
          const profile = GOAL_PROFILES[key];
          const field = form[key];
          const ranged = field.kind === 'range';
          return (
            <fieldset key={key}>
              <legend>{profile.label} ({profile.unit})</legend>
              {profile.allowed.length > 1 && (
                <label>
                  Type
                  <select value={field.kind} onChange={(event) => update(key, { kind: event.target.value })}>
                    {profile.allowed.map((kind) => (
                      <option key={kind} value={kind}>{kind === 'target' ? 'Target' : kind === 'range' ? 'Range' : kind === 'minimum' ? 'Minimum' : 'Maximum'}</option>
                    ))}
                  </select>
                </label>
              )}
              {ranged ? (
                <div className="split">
                  <label>
                    Minimum
                    <input inputMode="decimal" value={field.min} onChange={(event) => update(key, { min: event.target.value })} />
                  </label>
                  <label>
                    Maximum
                    <input inputMode="decimal" value={field.max} onChange={(event) => update(key, { max: event.target.value })} />
                  </label>
                </div>
              ) : (
                <label>
                  {profile.kind === 'maximum' ? 'Limit' : 'Amount'}
                  <input inputMode="decimal" value={field.amount} placeholder="None" onChange={(event) => update(key, { amount: event.target.value })} />
                </label>
              )}
            </fieldset>
          );
        })}
        {error && <p className="banner error" role="alert">{error}</p>}
        {saved && <p className="banner success" role="status">Targets saved from today onward.</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save targets'}</button>
      </form>
    </details>
  );
}
