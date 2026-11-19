import { assertDate, formatNumber, roundAmount, shiftDate, todayISO } from './nutrients.js';
import {
  STATUS_TEXT,
  evaluateIntake,
  goalConfigured,
  profileFor,
  referenceValue,
  successNoun,
} from './goals.js';

export const ANALYTICS_NUTRIENTS = [
  {
    key: 'protein',
    label: 'Protein',
    unit: 'g',
    source: 'food',
    note: 'Compared with your protein minimum.',
  },
  {
    key: 'carbohydrates',
    label: 'Carbohydrates',
    unit: 'g',
    source: 'food',
    note: 'Compared with your carbohydrate target or range.',
  },
  {
    key: 'salt',
    label: 'Salt',
    unit: 'g',
    source: 'food',
    note: 'Salt is tracked on its own. Sodium is never converted into salt or added to it. Going over the limit is not a success.',
  },
  {
    key: 'sugars',
    label: 'Sugar',
    unit: 'g',
    source: 'food',
    note: 'This view is total sugars. Added sugars stay separate and are not assumed from the total.',
    component: 'added_sugars',
  },
  {
    key: 'fibre',
    label: 'Fibre',
    unit: 'g',
    source: 'food',
    note: 'Compared with your fibre minimum. Days that reach it are marked as met.',
  },
  {
    key: 'water',
    label: 'Water',
    unit: 'ml',
    source: 'water',
    note: 'Plain water you record here. Water in food, tea, coffee, and other drinks is not included unless you add it yourself.',
  },
  {
    key: 'saturated_fat',
    label: 'Saturated fat',
    unit: 'g',
    source: 'food',
    note: 'Judged against your maximum. Exceeding it is not a success, and it is not interchangeable with unsaturated fat.',
  },
  {
    key: 'unsaturated_fat',
    label: 'Unsaturated fat',
    unit: 'g',
    source: 'food',
    note: 'Total unsaturated fat is shown only when a source states it. Monounsaturated and polyunsaturated fat are kept separate and are not added together.',
    components: ['monounsaturated_fat', 'polyunsaturated_fat'],
  },
];

const OVERALL_MACROS = ['protein', 'carbohydrates', 'fat', 'fibre'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function startOfWeek(iso) {
  const date = assertDate(iso);
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(year, month - 1, day).getDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return shiftDate(date, delta);
}

export function monthStart(iso) {
  return `${assertDate(iso).slice(0, 7)}-01`;
}

export function shiftMonths(iso, count) {
  const [year, month, day] = assertDate(iso).split('-').map(Number);
  const target = new Date(year, month - 1 + count, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return todayISO(new Date(target.getFullYear(), target.getMonth(), Math.min(day, last)));
}

export function shiftYears(iso, count) {
  return shiftMonths(iso, count * 12);
}

export function inclusiveDays(start, end) {
  const dates = [];
  let cursor = assertDate(start);
  const last = assertDate(end);
  if (cursor > last) return dates;
  while (cursor <= last) {
    dates.push(cursor);
    if (dates.length > 4000) throw new Error('That date range is too long.');
    cursor = shiftDate(cursor, 1);
  }
  return dates;
}

export function periodWindows(asOf) {
  const date = assertDate(asOf);
  const yesterday = shiftDate(date, -1);
  const weekStart = startOfWeek(date);
  const elapsed = inclusiveDays(weekStart, date).length;
  const previousWeekStart = shiftDate(weekStart, -7);
  const previousMonthDate = shiftMonths(date, -1);
  const previousYearDate = shiftYears(date, -1);
  return {
    day: {
      id: 'day',
      label: 'Today vs yesterday',
      note: 'Today is compared with yesterday. A day with no log is left blank rather than treated as zero.',
      current: { start: date, end: date, label: 'Today' },
      previous: { start: yesterday, end: yesterday, label: 'Yesterday' },
    },
    week: {
      id: 'week',
      label: 'This week vs last week',
      note: elapsed === 7
        ? 'This calendar week, Monday to Sunday, is compared with the previous calendar week.'
        : 'This week so far is compared with the same weekdays last week. Later days are left out so a short week is not compared with a full one.',
      current: { start: weekStart, end: date, label: 'This week' },
      previous: { start: previousWeekStart, end: shiftDate(previousWeekStart, elapsed - 1), label: 'Last week' },
    },
    month: {
      id: 'month',
      label: 'This month vs last month',
      note: 'This month so far is compared with the same dates last month. Averages are used so months of different lengths stay comparable. The previous month is clipped when it is shorter.',
      current: { start: monthStart(date), end: date, label: 'This month' },
      previous: { start: monthStart(previousMonthDate), end: previousMonthDate, label: 'Last month' },
    },
    year: {
      id: 'year',
      label: 'This year vs last year',
      note: 'This year so far is compared with the same dates last year, not with the whole of last year.',
      current: { start: `${date.slice(0, 4)}-01-01`, end: date, label: 'This year' },
      previous: { start: `${previousYearDate.slice(0, 4)}-01-01`, end: previousYearDate, label: 'Last year' },
    },
  };
}

export function formatMeasure(amount, unit) {
  if (amount == null || Number.isNaN(amount)) return '—';
  if (unit === 'ml') {
    const digits = Math.abs(amount) >= 100 ? 0 : 1;
    const rounded = roundAmount(amount, digits);
    const [whole, fraction] = String(rounded).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const text = fraction ? `${grouped}.${fraction}` : grouped;
    if (Math.abs(rounded) >= 1000) {
      const litres = String(roundAmount(rounded / 1000, 2));
      return `${text} ml (${litres} L)`;
    }
    return `${text} ml`;
  }
  const text = formatNumber(amount, unit);
  return text == null ? '—' : `${text} ${unit}`;
}

function goalOn(goals, date) {
  let found = null;
  for (const goal of goals) {
    if (goal.effectiveDate <= date) found = goal.details || {};
    else break;
  }
  return found || {};
}

function dayRecord(day, key) {
  if (key === 'water') {
    const entries = day?.water?.entries || 0;
    if (!entries) return { logged: false, amount: null, partial: false };
    return { logged: true, amount: day.water.amount, partial: false };
  }
  const foodEntries = day?.foodEntries || 0;
  if (!foodEntries) return { logged: false, amount: null, partial: false };
  const nutrient = day.nutrients?.[key];
  const known = nutrient?.known || 0;
  if (!known || nutrient.amount == null) return { logged: true, amount: null, partial: false };
  return {
    logged: true,
    amount: nutrient.amount,
    partial: known < foodEntries,
  };
}

function measurement(dates, byDate, goals, key) {
  const profile = profileFor(key);
  const points = dates.map((date) => {
    const record = dayRecord(byDate.get(date), key);
    const goal = goalOn(goals, date)[key] || null;
    const evaluation = evaluateIntake(profile, goal, record.amount, {
      partial: record.partial,
      logged: record.logged,
    });
    return { date, ...record, goal: goalConfigured(goal) ? goal : null, evaluation };
  });
  const recorded = points.filter((point) => point.amount != null);
  const complete = recorded.filter((point) => !point.partial);
  const total = recorded.length ? roundAmount(recorded.reduce((sum, point) => sum + point.amount, 0)) : null;
  const average = recorded.length ? roundAmount(total / recorded.length) : null;
  const evaluated = points.filter((point) => point.evaluation.success != null);
  const achieved = evaluated.filter((point) => point.evaluation.success);
  const endGoal = points.length ? points[points.length - 1].goal : null;
  const signatures = new Set(points.map((point) => JSON.stringify(point.goal)));
  return {
    calendarDays: dates.length,
    loggedDays: points.filter((point) => point.logged).length,
    coveredDays: recorded.length,
    partialDays: recorded.filter((point) => point.partial).length,
    completeDays: complete.length,
    total,
    average,
    evaluatedDays: evaluated.length,
    achievedDays: achieved.length,
    achievementPercent: evaluated.length ? roundAmount((achieved.length / evaluated.length) * 100, 1) : null,
    goal: endGoal,
    targetVaries: signatures.size > 1,
    status: points.length === 1 ? points[0].evaluation.status : null,
    percent: points.length === 1 ? points[0].evaluation.percent : null,
    partial: points.length === 1 ? points[0].partial : recorded.some((point) => point.partial),
    points,
  };
}

function delta(current, previous) {
  if (current == null || previous == null) return null;
  return roundAmount(current - previous);
}

function describeGoal(goal, unit) {
  if (!goalConfigured(goal)) return null;
  if (goal.kind === 'range') return `${formatMeasure(goal.min, unit)} to ${formatMeasure(goal.max, unit)}`;
  return formatMeasure(goal.amount, unit);
}

function intakeSentence(label, stats, unit) {
  if (!stats.coveredDays) {
    return stats.loggedDays
      ? `${label}: food was logged, but this nutrient was not stated. It is left blank rather than recorded as zero.`
      : `${label}: nothing logged.`;
  }
  const coverage = stats.partialDays
    ? ' Some foods did not list it, so this is the recorded amount only and may be low. Missing values were not filled in as zero.'
    : '';
  if (stats.calendarDays === 1) {
    const goal = describeGoal(stats.goal, unit);
    const percent = stats.percent != null ? ` (${stats.percent}% of ${goal})` : '';
    const status = stats.status && !['no_goal', 'unlogged'].includes(stats.status) ? ` ${STATUS_TEXT[stats.status]}.` : goal ? '' : ' No target is set.';
    const limitNote = stats.status === 'exceeding' ? ' Exceeding the limit is not counted as a success.' : '';
    return `${label}: ${formatMeasure(stats.total, unit)}${goal ? percent : ''}.${status}${limitNote}${coverage}`;
  }
  return `${label}: ${formatMeasure(stats.total, unit)} recorded across ${stats.coveredDays} day${stats.coveredDays === 1 ? '' : 's'} with data, averaging ${formatMeasure(stats.average, unit)} a day.${coverage}`;
}

function deltaSentence(amount, unit, averaged) {
  if (amount == null) return 'The difference is not calculated because one side has no recorded intake. Missing days are not treated as zero.';
  if (Math.abs(amount) < (unit === 'kcal' ? 0.05 : 0.0005)) {
    return averaged
      ? 'The daily averages match. That is a comparison, not a score.'
      : 'Recorded intake matches. That is a comparison, not a score.';
  }
  const word = amount > 0 ? 'higher' : 'lower';
  const basis = averaged ? 'The daily average is' : 'Recorded intake is';
  return `${basis} ${formatMeasure(Math.abs(amount), unit)} ${word} than the earlier period. A higher or lower number is a difference, not an improvement.`;
}

function seriesFrom(stats) {
  return {
    values: stats.points.map((point) => (point.amount == null ? null : point.amount)),
    partials: stats.points.map((point) => Boolean(point.partial)),
    targets: stats.points.map((point) => referenceValue(point.goal)),
  };
}

function chart(type, unit, categories, series, guides = []) {
  return {
    type,
    unit,
    categories,
    series,
    guides: (guides || []).filter((guide) => guide && typeof guide.value === 'number'),
  };
}

function constantGuides(points) {
  const values = [...new Set(points.map((point) => referenceValue(point.goal)).filter((value) => value != null))];
  if (values.length !== 1) return [];
  return [{ index: null, value: values[0], label: 'Target' }];
}

function pairChart(period, current, previous, unit, key) {
  if (period.id === 'year') return yearChart(period, current, previous, unit, 'average');
  if (period.id === 'day') {
    const currentSeries = seriesFrom(current);
    const previousSeries = seriesFrom(previous);
    return chart('bars', unit, [period.previous.label, period.current.label], [
      {
        id: 'intake',
        label: 'Intake',
        values: [previousSeries.values[0] ?? null, currentSeries.values[0] ?? null],
        partials: [previousSeries.partials[0] || false, currentSeries.partials[0] || false],
      },
    ], [
      previousSeries.targets[0] ?? null,
      currentSeries.targets[0] ?? null,
    ].map((target, index) => (target == null ? null : { index, value: target, label: 'Target' })));
  }
  const labels = axisLabels(period, current.points.map((point) => point.date));
  const currentSeries = seriesFrom(current);
  const previousSeries = seriesFrom(previous);
  return chart(period.id === 'week' ? 'bars' : 'lines', unit, labels, [
    { id: 'previous', label: period.previous.label, values: previousSeries.values, partials: previousSeries.partials },
    { id: 'current', label: period.current.label, values: currentSeries.values, partials: currentSeries.partials },
  ], currentSeries.targets.map((value, index) => (value == null ? null : { index, value, label: 'Target' })));
}

function axisLabels(period, dates) {
  if (period.id === 'week') {
    return dates.map((date) => {
      const [year, month, day] = date.split('-').map(Number);
      const weekday = new Date(year, month - 1, day).getDay();
      const index = weekday === 0 ? 6 : weekday - 1;
      return WEEKDAYS[index];
    });
  }
  if (period.id === 'month') return dates.map((date) => String(Number(date.slice(-2))));
  return dates;
}

function monthIndex(iso) {
  return Number(iso.slice(5, 7));
}

function monthlyValue(points, month, field) {
  const inMonth = points.filter((point) => monthIndex(point.date) === month);
  if (field === 'achievement') {
    const evaluated = inMonth.filter((point) => point.evaluation.success != null);
    if (!evaluated.length) return null;
    const achieved = evaluated.filter((point) => point.evaluation.success).length;
    return roundAmount((achieved / evaluated.length) * 100, 1);
  }
  const recorded = inMonth.filter((point) => point.amount != null);
  if (!recorded.length) return null;
  return roundAmount(recorded.reduce((sum, point) => sum + point.amount, 0) / recorded.length);
}

function yearChart(period, current, previous, unit, field) {
  const months = monthIndex(period.current.end);
  const categories = MONTHS.slice(0, months);
  const pick = (stats, month) => monthlyValue(stats.points, month, field);
  return chart('lines', field === 'achievement' ? '%' : unit, categories, [
    {
      id: 'previous',
      label: period.previous.end.slice(0, 4),
      values: categories.map((_, index) => pick(previous, index + 1)),
      partials: categories.map(() => false),
    },
    {
      id: 'current',
      label: period.current.end.slice(0, 4),
      values: categories.map((_, index) => pick(current, index + 1)),
      partials: categories.map(() => false),
    },
  ], field === 'achievement' ? [] : constantGuides(current.points));
}

function achievementChart(period, current, previous) {
  if (period.id === 'year') return yearChart(period, current, previous, '%', 'achievement');
  return chart('bars', '%', [period.previous.label, period.current.label], [
    {
      id: 'achievement',
      label: 'Goal achievement',
      values: [previous.achievementPercent, current.achievementPercent],
      partials: [false, false],
    },
  ]);
}

function macroChart(byDate, goals, period) {
  const currentDates = inclusiveDays(period.current.start, period.current.end);
  const previousDates = inclusiveDays(period.previous.start, period.previous.end);
  const categories = OVERALL_MACROS.map((key) => profileFor(key).label);
  const valueFor = (dates, key) => measurement(dates, byDate, goals, key).average;
  return chart('bars', 'g', categories, [
    { id: 'previous', label: period.previous.label, values: OVERALL_MACROS.map((key) => valueFor(previousDates, key)), partials: OVERALL_MACROS.map(() => false) },
    { id: 'current', label: period.current.label, values: OVERALL_MACROS.map((key) => valueFor(currentDates, key)), partials: OVERALL_MACROS.map(() => false) },
  ]);
}

function comparedDays(achieved, evaluated) {
  return evaluated ? `${achieved} of ${evaluated} comparable days` : 'no comparable days';
}

function overallSummary(period, calories) {
  const unit = 'kcal';
  const averaged = period.id !== 'day';
  const change = averaged ? delta(calories.current.average, calories.previous.average) : delta(calories.current.total, calories.previous.total);
  const goal = describeGoal(calories.current.goal, unit);
  const parts = [period.note];
  if (goal) {
    parts.push(calories.current.targetVaries
      ? `The calorie target changes across this period. The latest target is ${goal}, and each day is judged by the target that applied then.`
      : `Calorie target: ${goal}.`);
  } else parts.push('No calorie target is set for the latest day in this period.');
  parts.push(intakeSentence(period.current.label, calories.current, unit));
  parts.push(intakeSentence(period.previous.label, calories.previous, unit));
  if (calories.current.evaluatedDays || calories.previous.evaluatedDays) {
    parts.push(`${period.current.label}: ${calories.current.evaluatedDays ? `target met on ${comparedDays(calories.current.achievedDays, calories.current.evaluatedDays)}` : comparedDays(0, 0)}. ${period.previous.label}: ${calories.previous.evaluatedDays ? comparedDays(calories.previous.achievedDays, calories.previous.evaluatedDays) : comparedDays(0, 0)}.`);
  }
  parts.push(deltaSentence(change, unit, averaged));
  return parts.join(' ');
}

function nutrientSummary(period, stats, profile) {
  const averaged = period.id !== 'day';
  const change = averaged ? delta(stats.current.average, stats.previous.average) : delta(stats.current.total, stats.previous.total);
  const parts = [
    intakeSentence(period.current.label, stats.current, profile.unit),
    intakeSentence(period.previous.label, stats.previous, profile.unit),
  ];
  if (stats.current.evaluatedDays || stats.previous.evaluatedDays) {
    parts.push(`${successNoun(profile)}: ${comparedDays(stats.current.achievedDays, stats.current.evaluatedDays)} in ${period.current.label.toLowerCase()}, and ${comparedDays(stats.previous.achievedDays, stats.previous.evaluatedDays)} in ${period.previous.label.toLowerCase()}.`);
  }
  parts.push(deltaSentence(change, profile.unit, averaged));
  return parts.join(' ');
}

function snapshotSide(stats) {
  return {
    total: stats.total,
    average: stats.average,
    loggedDays: stats.loggedDays,
    coveredDays: stats.coveredDays,
    partialDays: stats.partialDays,
    calendarDays: stats.calendarDays,
    status: stats.status,
    percent: stats.percent,
    goal: stats.goal,
    partial: stats.partial,
    achievedDays: stats.achievedDays,
    evaluatedDays: stats.evaluatedDays,
    achievementPercent: stats.achievementPercent,
    targetVaries: stats.targetVaries,
  };
}

function extremes(byDate, key) {
  let highest = null;
  let lowest = null;
  for (const [date, day] of byDate) {
    const record = dayRecord(day, key);
    if (record.amount == null) continue;
    const candidate = { date, amount: record.amount, partial: record.partial };
    if (!highest || candidate.amount > highest.amount || (candidate.amount === highest.amount && candidate.date > highest.date)) highest = candidate;
    if (!lowest || candidate.amount < lowest.amount || (candidate.amount === lowest.amount && candidate.date > lowest.date)) lowest = candidate;
  }
  return { highest, lowest };
}

function averageOf(stats) {
  return {
    amount: stats.average,
    coveredDays: stats.coveredDays,
    partialDays: stats.partialDays,
    loggedDays: stats.loggedDays,
    calendarDays: stats.calendarDays,
  };
}

/**
 * Build the analytics view from daily aggregates and effective-dated goals.
 * Days absent from `days` are unlogged. Amounts are null when the nutrient was not stated.
 */
export function buildAnalytics({ asOf, days, goals }) {
  const date = assertDate(asOf);
  const orderedGoals = [...(goals || [])].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const byDate = new Map((days || []).map((day) => [day.date, day]));
  const windows = periodWindows(date);
  const keys = [
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
  const cache = new Map();
  function statsFor(periodId, side, key) {
    const id = `${periodId}|${side}|${key}`;
    if (!cache.has(id)) {
      const window = windows[periodId][side];
      cache.set(id, measurement(inclusiveDays(window.start, window.end), byDate, orderedGoals, key));
    }
    return cache.get(id);
  }

  const periods = {};
  for (const period of Object.values(windows)) {
    const calories = {
      current: snapshotSide(statsFor(period.id, 'current', 'calories')),
      previous: snapshotSide(statsFor(period.id, 'previous', 'calories')),
    };
    calories.totalDelta = delta(calories.current.total, calories.previous.total);
    calories.averageDelta = delta(calories.current.average, calories.previous.average);
    const macros = {};
    for (const key of OVERALL_MACROS) {
      const current = statsFor(period.id, 'current', key);
      const previous = statsFor(period.id, 'previous', key);
      macros[key] = {
        label: profileFor(key).label,
        unit: profileFor(key).unit,
        current: current.calendarDays === 1 ? current.total : current.average,
        previous: previous.calendarDays === 1 ? previous.total : previous.average,
        currentPartial: current.partialDays > 0,
        previousPartial: previous.partialDays > 0,
        currentCovered: current.coveredDays,
        previousCovered: previous.coveredDays,
      };
    }
    const nutrients = {};
    for (const key of keys) {
      if (key === 'calories') continue;
      const current = statsFor(period.id, 'current', key);
      const previous = statsFor(period.id, 'previous', key);
      const profile = profileFor(key);
      nutrients[key] = {
        current: snapshotSide(current),
        previous: snapshotSide(previous),
        totalDelta: delta(current.total, previous.total),
        averageDelta: delta(current.average, previous.average),
        chart: pairChart(period, current, previous, profile.unit, key),
        summary: nutrientSummary(period, { current, previous }, profile),
      };
    }
    const currentCalories = statsFor(period.id, 'current', 'calories');
    const previousCalories = statsFor(period.id, 'previous', 'calories');
    periods[period.id] = {
      ...period,
      overall: {
        calories,
        macros,
        logged: {
          current: currentCalories.loggedDays,
          previous: previousCalories.loggedDays,
        },
        charts: {
          calories: pairChart(period, currentCalories, previousCalories, 'kcal', 'calories'),
          achievement: achievementChart(period, currentCalories, previousCalories),
          macros: macroChart(byDate, orderedGoals, period),
        },
        summary: overallSummary(period, { current: currentCalories, previous: previousCalories }),
      },
      nutrients,
    };
  }

  function nutrientSnapshot(key) {
    return {
      key,
      label: profileFor(key).label,
      unit: profileFor(key).unit,
      profile: profileFor(key),
      today: snapshotSide(statsFor('day', 'current', key)),
      yesterday: snapshotSide(statsFor('day', 'previous', key)),
      averages: {
        week: averageOf(statsFor('week', 'current', key)),
        month: averageOf(statsFor('month', 'current', key)),
        year: averageOf(statsFor('year', 'current', key)),
      },
      extremes: extremes(byDate, key),
    };
  }

  const nutrientViews = {};
  for (const item of ANALYTICS_NUTRIENTS) {
    const componentKeys = item.components || (item.component ? [item.component] : []);
    nutrientViews[item.key] = {
      ...item,
      ...nutrientSnapshot(item.key),
      components: componentKeys.map((key) => nutrientSnapshot(key)),
    };
  }

  return {
    asOf: date,
    weekStartsOn: 'Monday',
    periods,
    nutrients: nutrientViews,
    goal: goalOn(orderedGoals, date),
  };
}
