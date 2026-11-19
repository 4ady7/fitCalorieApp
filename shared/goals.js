/** How a personal target is judged. Kinds are chosen by the user; these are the defaults. */

export const GOAL_PROFILES = {
  calories: {
    kind: 'target',
    match: 'close',
    allowed: ['target', 'range'],
    label: 'Calories',
    unit: 'kcal',
    blurb: 'A single target counts as met within 5% either side. Set a range when you want different bounds. A higher intake is not treated as a better result.',
  },
  protein: {
    kind: 'minimum',
    match: 'at_least',
    allowed: ['minimum'],
    label: 'Protein',
    unit: 'g',
    blurb: 'Protein is a minimum. Meeting or exceeding it counts as met. A higher intake is not praised beyond that.',
  },
  carbohydrates: {
    kind: 'target',
    match: 'close',
    allowed: ['target', 'range'],
    label: 'Carbohydrates',
    unit: 'g',
    blurb: 'A single target counts as met within 5% either side. A range uses the bounds you set.',
  },
  fat: {
    kind: 'target',
    match: 'close',
    allowed: ['target', 'range'],
    label: 'Total fat',
    unit: 'g',
    blurb: 'A single target counts as met within 5% either side. Saturated and unsaturated fat are not interchangeable with this total.',
  },
  fibre: {
    kind: 'minimum',
    match: 'at_least',
    allowed: ['minimum'],
    label: 'Fibre',
    unit: 'g',
    blurb: 'Fibre is a minimum. The day counts as met when intake reaches the target.',
  },
  sugars: {
    kind: 'maximum',
    match: 'at_most',
    allowed: ['maximum'],
    label: 'Sugar',
    unit: 'g',
    blurb: 'Sugar is total sugars, judged against a maximum. Going over the limit is not a success. Added sugars are a separate nutrient.',
  },
  added_sugars: {
    kind: 'maximum',
    match: 'at_most',
    allowed: ['maximum'],
    label: 'Added sugars',
    unit: 'g',
    blurb: 'Added sugars are judged on their own. They are never copied from total sugars.',
  },
  salt: {
    kind: 'maximum',
    match: 'at_most',
    allowed: ['maximum'],
    label: 'Salt',
    unit: 'g',
    blurb: 'Salt is a maximum. Staying under the limit counts as met, and going over does not. Sodium is not added to salt.',
  },
  saturated_fat: {
    kind: 'maximum',
    match: 'at_most',
    allowed: ['maximum'],
    label: 'Saturated fat',
    unit: 'g',
    blurb: 'Saturated fat is a maximum. Exceeding the limit is not a success, and it is not interchangeable with unsaturated fat.',
  },
  unsaturated_fat: {
    kind: 'target',
    match: 'close',
    allowed: ['target', 'minimum', 'range'],
    label: 'Unsaturated fat',
    unit: 'g',
    blurb: 'Set a target only if you want one. Total unsaturated fat is used only when a source states it. Monounsaturated and polyunsaturated fat are not added together to fill it in.',
  },
  monounsaturated_fat: {
    kind: 'target',
    match: 'close',
    allowed: ['target', 'minimum', 'range'],
    label: 'Monounsaturated fat',
    unit: 'g',
    blurb: 'Optional target for monounsaturated fat. It is not combined with polyunsaturated fat.',
  },
  polyunsaturated_fat: {
    kind: 'target',
    match: 'close',
    allowed: ['target', 'minimum', 'range'],
    label: 'Polyunsaturated fat',
    unit: 'g',
    blurb: 'Optional target for polyunsaturated fat. It is not combined with monounsaturated fat.',
  },
  water: {
    kind: 'target',
    match: 'at_least',
    allowed: ['target'],
    label: 'Water',
    unit: 'ml',
    blurb: 'Water counts as met when the amount you record reaches the target. This is plain water you log, not drinks or the water in food.',
  },
};

export const STATUS_TEXT = {
  achieved: 'Target met',
  below: 'Below target',
  above: 'Above target',
  within: 'Within the limit',
  approaching: 'Approaching the limit',
  exceeding: 'Over the limit',
  insufficient: 'Incomplete data',
  no_goal: 'No target set',
  unlogged: 'Not logged',
};

const CLOSE_BAND = 0.05;
const APPROACH_BAND = 0.85;

export function profileFor(key) {
  return GOAL_PROFILES[key] || {
    kind: 'target',
    match: 'close',
    allowed: ['target'],
    label: key,
    unit: '',
    blurb: '',
  };
}

export function goalConfigured(goal) {
  if (!goal) return false;
  if (goal.kind === 'range') return goal.min > 0 && goal.max > 0 && goal.min <= goal.max;
  return goal.amount > 0;
}

function percentOf(amount, base) {
  if (!(base > 0) || typeof amount !== 'number') return null;
  return Math.round((amount / base) * 1000) / 10;
}

function result(status, percent, success, partial = false) {
  return { status, percent, success, partial };
}

function evaluateComplete(profile, goal, amount) {
  const kind = goal.kind || profile.kind;
  if (kind === 'range') {
    if (amount < goal.min) return result('below', percentOf(amount, goal.min), false);
    if (amount > goal.max) return result('above', percentOf(amount, goal.max), false);
    return result('within', percentOf(amount, (goal.min + goal.max) / 2), true);
  }
  if (kind === 'minimum' || (kind === 'target' && profile.match === 'at_least')) {
    const status = amount + 1e-9 >= goal.amount ? 'achieved' : 'below';
    return result(status, percentOf(amount, goal.amount), status === 'achieved');
  }
  if (kind === 'maximum' || (kind === 'target' && profile.match === 'at_most')) {
    const ratio = amount / goal.amount;
    let status = 'within';
    if (amount > goal.amount + 1e-9) status = 'exceeding';
    else if (ratio >= APPROACH_BAND) status = 'approaching';
    return result(status, percentOf(amount, goal.amount), status !== 'exceeding');
  }
  const ratio = amount / goal.amount;
  let status = 'achieved';
  if (ratio < 1 - CLOSE_BAND) status = 'below';
  else if (ratio > 1 + CLOSE_BAND) status = 'above';
  return result(status, percentOf(amount, goal.amount), status === 'achieved');
}

function evaluatePartial(profile, goal, amount) {
  const kind = goal.kind || profile.kind;
  const atLeast = kind === 'minimum' || (kind === 'target' && profile.match === 'at_least');
  const atMost = kind === 'maximum' || (kind === 'target' && profile.match === 'at_most');
  if (atLeast && amount + 1e-9 >= goal.amount) {
    return result('achieved', percentOf(amount, goal.amount), true, true);
  }
  if (atMost && amount > goal.amount + 1e-9) {
    return result('exceeding', percentOf(amount, goal.amount), false, true);
  }
  if (kind === 'range' && amount > goal.max + 1e-9) {
    return result('above', percentOf(amount, goal.max), false, true);
  }
  return result('insufficient', null, null, true);
}

/**
 * Judge one day's intake.
 * `logged` means the user recorded the relevant log (food, or water).
 * A missing amount is never treated as zero.
 * Partial food days can confirm a minimum already met or a maximum already exceeded.
 * They cannot confirm a close target.
 */
export function evaluateIntake(profile, goal, amount, { partial = false, logged = false } = {}) {
  if (!logged) return result('unlogged', null, null);
  if (amount == null) return result('insufficient', null, null);
  if (!goalConfigured(goal)) return result('no_goal', null, null);
  if (partial) return evaluatePartial(profile, goal, amount);
  return evaluateComplete(profile, goal, amount);
}

export function referenceValue(goal) {
  if (!goalConfigured(goal)) return null;
  if (goal.kind === 'range') return null;
  return goal.amount;
}

export function successNoun(profile) {
  if (!profile) return 'Days target met';
  if (profile.kind === 'maximum' || profile.match === 'at_most') return 'Days within the limit';
  if (profile.match === 'at_least' || profile.kind === 'minimum') return 'Days target met';
  return 'Days on target';
}
