import { averageSpent, monthView, targetNeed, type CatMonth, type Index } from './budget'
import { addMonths } from './dates'
import type { ID, Month } from './types'

/*
  The planner: what each category should get in a month, filling it in as far as the money goes,
  and how the coming months play out. Pure functions of the index.

  Order of priority (pay yourself first, after what's owed):
    1. targets, and overspending to clear
    2. savings categories, toward the savings target (share of expected income)
    3. everyday categories at their usual cost (3-month average spent), minus what they already have
*/

const UNIT = 100 // suggestions are whole currency units

const roundUp = (v: number) => Math.ceil(v / UNIT) * UNIT
const round = (v: number) => Math.round(v / UNIT) * UNIT

function median(vs: number[]): number {
  if (!vs.length) return 0
  const s = [...vs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Usual income: the median of the last 3 finished months (only months the budget existed in). 0 without history. */
export function expectedIncome(ix: Index, current: Month): number {
  const first = ix.months[0]
  if (!first) return 0
  const vs: number[] = []
  for (let i = 1; i <= 3; i++) {
    const m = addMonths(current, -i)
    if (m >= first) vs.push(ix.income.get(m) ?? 0)
  }
  return round(median(vs))
}

/** What the savings target asks of a month: a share of the income expected (or already in, if more). */
export function savingsGoal(ix: Index, month: Month, current: Month): number {
  const rate = ix.settings.savingsTarget || 0
  if (rate <= 0) return 0
  const inc = expectedIncome(ix, current)
  const got = month <= current ? ix.income.get(month) ?? 0 : 0
  return round(rate * Math.max(inc, got))
}

export interface Suggestion {
  cat: ID
  /** what the month should get assigned in total */
  want: number
  /** the part of `want` that comes first: a target, or overspending to clear */
  base: number
  /** already assigned */
  assigned: number
  saving: boolean
}

/** A category's usual monthly cost, in whole units. */
function usual(ix: Index, cat: ID, anchor: Month): number {
  return roundUp(Math.max(0, averageSpent(ix, cat, anchor, 3)))
}

/** Share `total` by weights, in whole units; the rounding remainder goes to the last share. */
function share(total: number, weights: number[]): number[] {
  const w = weights.reduce((s, x) => s + x, 0)
  const out = weights.map((x) => (w > 0 ? round((total * x) / w) : 0))
  if (out.length) out[out.length - 1] += total - out.reduce((s, x) => s + x, 0)
  return out
}

/**
 * What each category should get in a month, in budget order. A coming month stands on its own: it
 * needs its targets, its savings and its usual costs (only goals count what is already put aside).
 */
export function suggestions(ix: Index, month: Month, current: Month): Suggestion[] {
  const view = monthView(ix, month, current)
  const future = month > current
  const anchor = future ? current : month
  const out: Suggestion[] = []
  const savers: { s: Suggestion; c: CatMonth }[] = []
  for (const c of view.cats) {
    const cat = c.cat
    if (cat.archived) continue
    const t = cat.target
    let base: number
    if (!future) base = c.goal // includes overspending carried in
    else if (!t) base = 0
    else if (t.kind === 'topup' || t.kind === 'refill') base = t.amount
    else if (t.kind === 'monthly') {
      // What a month uses up and has to be filled again (all of it, with nothing spent lately to go by).
      const u = usual(ix, cat.id, anchor)
      base = u > 0 ? Math.min(t.amount, u) : t.amount
    }
    else base = targetNeed(cat, c.carry, 0, month).goal
    const s: Suggestion = { cat: cat.id, want: base, base, assigned: c.assigned, saving: !!cat.saving }
    if (cat.saving) savers.push({ s, c })
    else if (!t) {
      // Usual cost, less what it starts the month with (a debt adds to it).
      const u = usual(ix, cat.id, anchor)
      s.want = Math.max(base, future ? u : roundUp(Math.max(0, u - c.carry)))
    }
    out.push(s)
  }

  // Savings: top the saving categories up to the month's savings target, shared by how they were
  // funded lately (else by their targets, else evenly). Money already given to them counts.
  const goal = savingsGoal(ix, month, current)
  if (savers.length && goal > 0) {
    const have = savers.reduce((sum, { s }) => sum + Math.max(s.base, s.assigned), 0)
    const room = round(Math.max(0, goal - have))
    if (room > 0) {
      let weights = savers.map(({ s }) => {
        let v = 0
        for (let i = 1; i <= 3; i++) v += Math.max(0, ix.asg.get(addMonths(anchor, -i))?.get(s.cat) ?? 0)
        return v
      })
      if (!weights.some((w) => w > 0)) weights = savers.map(({ c }) => c.cat.target?.amount ?? 0)
      if (!weights.some((w) => w > 0)) weights = savers.map(() => 1)
      share(room, weights).forEach((v, i) => {
        const s = savers[i].s
        s.want = Math.max(s.base, s.assigned) + v
      })
    }
  }
  return out
}

/** How much more a suggestion asks for. */
export const extraOf = (s: Suggestion) => Math.max(0, s.want - s.assigned)

export interface Fill {
  cat: ID
  /** the new assigned total */
  amount: number
  /** added to what was there */
  add: number
}

/**
 * Assign the suggestions as far as `money` goes, by priority: targets and overspending, then savings,
 * then usual costs; in budget order within each. Returns the new totals to commit.
 */
export function fillPlan(list: Suggestion[], money: number): Fill[] {
  let left = money
  const add = new Map<ID, number>()
  const give = (s: Suggestion, upTo: number) => {
    const had = s.assigned + (add.get(s.cat) ?? 0)
    const v = Math.min(left, Math.max(0, upTo - had))
    if (v <= 0) return
    add.set(s.cat, (add.get(s.cat) ?? 0) + v)
    left -= v
  }
  for (const s of list) if (left > 0) give(s, s.base)
  for (const s of list) if (left > 0 && s.saving) give(s, s.want)
  for (const s of list) if (left > 0 && !s.saving) give(s, s.want)
  return list.filter((s) => add.has(s.cat)).map((s) => ({ cat: s.cat, amount: s.assigned + add.get(s.cat)!, add: add.get(s.cat)! }))
}

export interface ForecastMonth {
  month: Month
  /** what the month's plan still needs */
  need: number
  /** money left once this month's plan is met, counting the usual income (negative: short by that much) */
  left: number
  /** nothing more to assign: the month is fully planned already */
  funded: boolean
  /** paid for by money already in hand, no income needed */
  covered: boolean
}

export interface Forecast {
  months: ForecastMonth[]
  /** the first month whose plan the money doesn't cover, counting the usual income */
  runsOut: Month | null
  /** a typical month's plan */
  typical: number
  /** whole months after this one whose plans the money in hand already pays for */
  ahead: number
  /** the last of those months */
  until: Month | null
  income: number
}

/** How far "months ahead" looks. */
export const MAX_AHEAD = 24

/**
 * The coming months, two ways.
 * With income: start from Ready to assign (plus income still expected this month), add the usual
 * income each month and take away what each month's plan still needs; where that goes below zero
 * the plan outgrows the income.
 * Without: the money in hand (Ready to assign plus what is already given to coming months), once
 * this month's plan is met, pays for one whole month's plan after another; `ahead` is how many.
 */
export function forecast(ix: Index, current: Month, n = 6): Forecast {
  const income = expectedIncome(ix, current)
  const now = monthView(ix, current, current)
  let money = now.readyToAssign + Math.max(0, income - now.income)
  let hand = now.readyToAssign
  for (const [m, a] of ix.asg) {
    if (m <= current) continue
    for (const [id, v] of a) if (!ix.catById.get(id)?.archived) hand += v
  }
  const months: ForecastMonth[] = []
  let runsOut: Month | null = null
  let typical = 0
  let ahead = 0
  let until: Month | null = null
  let paying = true
  for (let i = 0; i < Math.max(n, MAX_AHEAD + 1); i++) {
    if (i >= n && !paying) break
    const m = addMonths(current, i)
    const list = suggestions(ix, m, current)
    const need = list.reduce((s, x) => s + extraOf(x), 0)
    if (i === 1) typical = list.reduce((s, x) => s + x.want, 0)
    // This month needs what isn't assigned yet, and at least what clears its overspending; a coming month
    // needs its whole plan (what's given to it already is in hand).
    const cost =
      i === 0
        ? list.reduce((s, x) => s + Math.max(extraOf(x), -(now.byId.get(x.cat)?.available ?? 0)), 0)
        : list.reduce((s, x) => s + Math.max(x.want, x.assigned), 0)
    let covered = false
    if (paying && hand >= cost && (i === 0 || cost > 0)) {
      hand -= cost
      covered = true
      if (i > 0) {
        ahead = i
        until = m
      }
    } else paying = false
    if (i >= n) continue
    if (i > 0) money += income
    money -= i === 0 ? cost : need
    months.push({ month: m, need, left: money, funded: need === 0, covered })
    if (money < 0 && !runsOut) runsOut = m
  }
  return { months, runsOut, typical, ahead, until, income }
}

/** Categories that have ever had money or transactions: deleting them needs a choice about their history. */
export function catsWithHistory(ix: Index): Set<ID> {
  const ids = new Set<ID>()
  for (const a of ix.act.values()) for (const id of a.keys()) ids.add(id)
  for (const a of ix.asg.values()) for (const [id, v] of a) if (v) ids.add(id)
  return ids
}
