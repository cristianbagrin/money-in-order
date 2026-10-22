// The plain numbers behind Review: what a month planned, what was saved, and wealth over time.
// Pure functions over the Index. All amounts are integer minor units in the base currency.

import { countsDesc, investAccounts, wealthSeries, type WealthPoint } from './accounts'
import { monthView, type CatMonth, type Index, type MonthView } from './budget'
import { addMonths, monthOf } from './dates'
import { fmt } from './money'
import type { Category } from './types'

/** Money kept toward a goal or a buffer, not meant to be spent this month. */
export function setAside(cat: Category): boolean {
  const t = cat.target
  return !!t && (t.kind === 'goal' || (t.kind === 'refill' && !cat.daily))
}

/**
 * What a category planned to spend in its month: what it had for that month's own spending.
 * Leftover money that went to clear debt from earlier months isn't unspent plan, and that debt isn't
 * this month's overspending. Money set aside toward a goal or buffer only counts as far as it was spent.
 */
export function plannedOf(c: CatMonth): number {
  const spent = Math.max(0, -c.activity)
  const had = c.carry >= 0 ? c.carry + c.assigned : Math.max(Math.min(spent, c.assigned), c.carry + c.assigned)
  const planned = Math.max(0, had)
  return setAside(c.cat) ? Math.min(planned, spent) : planned
}

/** Planned spending in a month, savings categories left out. */
export function totalPlanned(view: MonthView): number {
  let s = 0
  for (const c of view.cats) if (!c.cat.saving) s += plannedOf(c)
  return s
}

/** Did this month's own spending push the category below zero? Debt carried in from earlier doesn't count. */
export function wentOver(c: CatMonth): boolean {
  const short = Math.max(0, -c.available)
  return short - Math.min(Math.max(0, -c.carry), short) > 0
}

/**
 * Share of income given to savings. Null without income, and when more went to savings than came in:
 * then the starting balance or earlier money paid for it, and a rate above 100% would mislead.
 */
export function savingsRate(v: MonthView): number | null {
  return v.income > 0 && v.saved <= v.income ? v.saved / v.income : null
}

/** Middle value; the mean of the two middle ones for an even count. */
export function median(values: number[]): number {
  if (!values.length) return 0
  const v = [...values].sort((a, b) => a - b)
  const h = v.length >> 1
  return v.length % 2 ? v[h] : Math.round((v[h - 1] + v[h]) / 2)
}

const pct = (x: number) => `${Math.round(x * 100)}%`

// ---------------------------------------------------------------- saving

export interface SavedLine {
  text: string
  /** the target is met (or there is none and something was saved) */
  good: boolean
  /** the rate, for marking it in the sentence; null when the sentence has none */
  rate: string | null
}

/** The month's saving in plain words against the target: "Saved 18% of income · target 20%". */
export function savedLine(ix: Index, month: string, today: string): SavedLine | null {
  const v = monthView(ix, month, monthOf(today))
  const base = ix.settings.base
  const target = ix.settings.savingsTarget || 0
  if (v.saved < 0) return { text: `Took ${fmt(-v.saved, base)} out of savings`, good: false, rate: null }
  if (v.income <= 0) return v.saved > 0 ? { text: `Saved ${fmt(v.saved, base)}`, good: true, rate: null } : null
  // the starting balance or earlier months paid for it: a rate would read above 100%
  if (v.saved > v.income) return { text: `Saved ${fmt(v.saved, base)}, more than came in`, good: true, rate: null }
  const rate = v.saved / v.income
  return {
    text: `Saved ${pct(rate)} of income${target > 0 ? ` · target ${pct(target)}` : ''}`,
    good: target > 0 ? rate + 0.005 >= target : rate > 0,
    rate: pct(rate),
  }
}

// ---------------------------------------------------------------- wealth

export interface Wealth {
  /** month ends, oldest first, the month shown last */
  points: WealthPoint[]
  /** total at the end of the first point to the last */
  change: number
  /** money put into investments after the first point */
  added: number
  /** what investments did beyond the money put in, over the months that can tell; null without investment accounts */
  growth: number | null
}

/**
 * Net worth (cash + investments) at the end of each of up to `n` months ending at `month`, from the first
 * month with data. Growth leaves out the month an investment's value is first typed in: that jump is money
 * it already held, not growth.
 */
export function wealth(ix: Index, month: string, today: string, n = 12): Wealth | null {
  const first = ix.months[0]
  if (!first || month < first) return null
  const months: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const m = addMonths(month, -i)
    if (m >= first) months.push(m)
  }
  const points = wealthSeries(ix, months, today)
  const invests = investAccounts(ix)
  // the month each investment's value was first typed in
  const firstTyped = new Set<string>()
  const counts = countsDesc(ix)
  for (const a of invests) {
    let at: string | undefined
    for (const c of counts) if (c.bal[a.id] !== undefined && !c.carried?.includes(a.id)) at = c.date
    if (at) firstTyped.add(monthOf(at))
  }
  let added = 0
  let growth = 0
  for (let k = 1; k < points.length; k++) {
    const p = points[k]
    added += p.added
    if (!firstTyped.has(p.month)) growth += p.invest - points[k - 1].invest - p.added
  }
  const last = points[points.length - 1]
  return { points, change: last.total - points[0].total, added, growth: invests.length ? Math.round(growth) : null }
}
