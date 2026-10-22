// The analytics behind Review: plain numbers and sentences that say what the budget means.
// Pure functions over the Index. All amounts are integer minor units in the base currency.

import { daily, monthView, type CatMonth, type Index, type MonthView } from './budget'
import { addDays, addMonths, dayOfMonth, daysInMonth, monthName, monthOf } from './dates'
import { fmt } from './money'
import { RTA, type Category, type ID } from './types'

/** Days into a month before averages and "than usual" comparisons mean anything. */
const SETTLED = 5

// ---------------------------------------------------------------- helpers

/** Non-saving categories (archived included, so history still adds up). */
function spendIds(ix: Index): Set<ID> {
  const ids = new Set<ID>()
  for (const c of ix.cats) if (!c.saving) ids.add(c.id)
  return ids
}

/**
 * Everyday spending: the daily categories (the ones Today spreads over the days left),
 * or all spending when there are none. A planned one-off purchase doesn't belong here.
 */
function everydayIds(ix: Index): { ids: Set<ID>; daily: boolean } {
  const ids = new Set<ID>()
  for (const c of ix.cats) if (c.daily && !c.saving && !c.archived) ids.add(c.id)
  return ids.size ? { ids, daily: true } : { ids: spendIds(ix), daily: false }
}

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

/**
 * How far below zero a category is, split into this month's own overspending and debt carried in from
 * earlier months that is still not covered. `own + carried` is the red number Plan shows.
 */
function shortfall(c: CatMonth): { own: number; carried: number } {
  const short = Math.max(0, -c.available)
  const carried = Math.min(Math.max(0, -c.carry), short)
  return { own: short - carried, carried }
}

/** Did this month's own spending push the category below zero? Debt carried in from earlier doesn't count. */
export function wentOver(c: CatMonth): boolean {
  return shortfall(c).own > 0
}

/**
 * Share of income given to savings. Null without income, and when more went to savings than came in:
 * then the starting balance or earlier money paid for it, and a rate above 100% would mislead.
 */
export function savingsRate(v: MonthView): number | null {
  return v.income > 0 && v.saved <= v.income ? v.saved / v.income : null
}

/** Spending per day of `month` (index 0 = day 1), positive numbers, the given categories only. */
function spendingByDay(ix: Index, month: string, ids: Set<ID>): { days: number[]; count: number } {
  const days = new Array<number>(daysInMonth(month)).fill(0)
  let count = 0
  for (const t of ix.txns) {
    if (t.cat === RTA || !ids.has(t.cat) || monthOf(t.date) !== month) continue
    days[dayOfMonth(t.date) - 1] -= t.base
    count++
  }
  return { days, count }
}

/** Spending per category in `month` through day `limit`, positive. */
function spentThrough(ix: Index, month: string, limit: number, ids: Set<ID>): Map<ID, number> {
  const sums = new Map<ID, number>()
  for (const t of ix.txns) {
    if (monthOf(t.date) !== month || !ids.has(t.cat) || dayOfMonth(t.date) > limit) continue
    sums.set(t.cat, (sums.get(t.cat) ?? 0) - t.base)
  }
  return sums
}

/** The day of month `m` that matches day `elapsed` of a `days`-long month, by the share of the month gone. */
function samePoint(m: string, elapsed: number, days: number): number {
  return Math.round((elapsed * daysInMonth(m)) / days)
}

/** Middle value; the mean of the two middle ones for an even count. */
export function median(values: number[]): number {
  if (!values.length) return 0
  const v = [...values].sort((a, b) => a - b)
  const h = v.length >> 1
  return v.length % 2 ? v[h] : Math.round((v[h - 1] + v[h]) / 2)
}

function cumulative(values: number[]): number[] {
  let run = 0
  return values.map((v) => (run += v))
}

/** Stretch a cumulative curve to `days` points, matching by the share of the month that has passed. */
function resample(cum: number[], days: number): number[] {
  const n = cum.length
  if (!n) return []
  const at = (k: number) => (k <= 0 ? 0 : cum[Math.min(k, n) - 1])
  const out: number[] = []
  for (let i = 0; i < days; i++) {
    const p = ((i + 1) * n) / days
    const lo = Math.floor(p)
    const f = p - lo
    out.push(Math.round(at(lo) + (at(lo + 1) - at(lo)) * f))
  }
  return out
}

/** Whole days between two "YYYY-MM-DD" dates (b − a). */
function dayDiff(a: string, b: string): number {
  const toNum = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d) / 86_400_000
  }
  return Math.round(toNum(b) - toNum(a))
}

/** Monday on or before `date`. */
function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7
  return addDays(date, -dow)
}

/** Spending between two dates inclusive, the given categories, positive. */
function spentBetween(ix: Index, from: string, to: string, ids: Set<ID>): number {
  let s = 0
  for (const t of ix.txns) {
    if (t.date > to) continue
    if (t.date < from) break // newest first
    if (t.cat !== RTA && ids.has(t.cat)) s -= t.base
  }
  return s
}

/** Date of the oldest transaction, if any. */
function earliestDate(ix: Index): string | null {
  return ix.txns.length ? ix.txns[ix.txns.length - 1].date : null
}

// ---------------------------------------------------------------- months

export interface MonthPoint {
  month: string
  income: number
  /** spending outside savings categories, positive */
  spent: number
  /** money given to savings categories */
  saved: number
  /** share of income saved; null without income or when savings were more than the income */
  savingsRate: number | null
  /** planned spending, see plannedOf() */
  planned: number
}

export function monthSeries(ix: Index, months: string[], current: string): MonthPoint[] {
  return months.map((month) => {
    const v = monthView(ix, month, current)
    return {
      month,
      income: v.income,
      spent: v.spent,
      saved: v.saved,
      savingsRate: savingsRate(v),
      planned: totalPlanned(v),
    }
  })
}

// ---------------------------------------------------------------- this month vs plan

export interface Burn {
  /** the month this curve describes */
  month?: string
  days: number
  /**
   * Day of the month that is today (1-based) when `month` is the current month,
   * 0 for a month that hasn't started, null for a month that is over.
   */
  today: number | null
  /** total planned spending for the month (non-saving categories) */
  plan: number
  /** the part of the plan in daily categories, spent evenly over the month; the rest can go on any day */
  dailyPlan: number
  /** cumulative spending; index 0 = end of day 1; null after today */
  actual: (number | null)[]
  /** the previous month's cumulative curve stretched to `days` points (same share of the month); empty when it had no spending */
  previous: number[]
  /** where the month ends if daily categories keep their average so far; null when there's nothing to go on yet */
  projected: number | null
}

export function burn(ix: Index, month: string, today: string): Burn {
  const current = monthOf(today)
  const days = daysInMonth(month)
  const ids = spendIds(ix)
  const cut = month < current ? days : month > current ? 0 : dayOfMonth(today)
  const cum = cumulative(spendingByDay(ix, month, ids).days)
  const prev = spendingByDay(ix, addMonths(month, -1), ids)
  const view = monthView(ix, month, current)
  const everyday = everydayIds(ix)
  let dailyPlan = 0
  if (everyday.daily) for (const c of view.cats) if (everyday.ids.has(c.cat.id)) dailyPlan += plannedOf(c)
  let projected: number | null = null
  if (everyday.daily && month === current && cut >= SETTLED && cut < days) {
    const soFar = spendingByDay(ix, month, everyday.ids).days.slice(0, cut).reduce((s, v) => s + v, 0)
    // everything logged this month (later dates included) plus everyday spending at its average so far
    if (soFar > 0) projected = cum[days - 1] + Math.round((soFar / cut) * (days - cut))
  }
  return {
    month,
    days,
    today: month < current ? null : cut,
    plan: totalPlanned(view),
    dailyPlan,
    actual: cum.map((v, i) => (i < cut ? v : null)),
    previous: prev.count ? resample(cumulative(prev.days), days) : [],
    projected,
  }
}

// ---------------------------------------------------------------- categories

export interface CatTrend {
  id: string
  name: string
  /**
   * Spending per month, oldest first, ending at `month` (months before any data are left out).
   * For the current month each value is what was spent by the same point of that month.
   */
  series: number[]
  thisMonth: number
  /** mean of the earlier values in `series` from months with activity in this category */
  average: number
  /** the month before, at the same point; null when it is before the data */
  last: number | null
  /** a typical month: the median of up to three months before, from months the category was used; null without any */
  usual: number | null
  /** planned spending this month, see plannedOf() */
  planned: number
  /** months in the window whose own spending pushed the category below zero */
  overMonths: number
}

function windowMonths(ix: Index, month: string, n: number): string[] {
  const first = ix.months[0]
  const out: string[] = []
  for (let i = Math.max(1, n) - 1; i >= 0; i--) {
    const m = addMonths(month, -i)
    if (m === month || (first !== undefined && m >= first)) out.push(m)
  }
  return out
}

/** Non-saving, non-archived categories that had spending or a plan in the window, biggest spending first. */
export function categoryTrends(ix: Index, month: string, today: string, n = 6): CatTrend[] {
  const current = monthOf(today)
  const months = windowMonths(ix, month, n)
  const views = months.map((m) => monthView(ix, m, current))
  const now = views[views.length - 1]
  const days = daysInMonth(month)
  const elapsed = month === current ? dayOfMonth(today) : days
  const ids = spendIds(ix)
  // so far this month, and the same point of the earlier months
  const sums = months.map((m) => spentThrough(ix, m, m === month ? elapsed : samePoint(m, elapsed, days), ids))
  const out: CatTrend[] = []
  for (const cat of ix.cats) {
    if (cat.saving || cat.archived) continue
    const series = sums.map((s) => s.get(cat.id) ?? 0)
    const cm = now.byId.get(cat.id)
    const planned = cm ? plannedOf(cm) : 0
    if (!planned && months.every((m) => !ix.act.get(m)?.get(cat.id))) continue
    let total = 0
    let count = 0
    for (let i = 0; i < months.length - 1; i++) {
      if (ix.act.get(months[i])?.has(cat.id)) {
        total += series[i]
        count++
      }
    }
    const used = months.map((m) => !!(ix.act.get(m)?.has(cat.id) || ix.asg.get(m)?.has(cat.id)))
    let overMonths = 0
    for (const v of views) {
      const c = v.byId.get(cat.id)
      if (c && wentOver(c)) overMonths++
    }
    out.push({
      id: cat.id,
      name: cat.name,
      series,
      thisMonth: series[series.length - 1],
      average: count ? Math.round(total / count) : 0,
      ...against(series, used),
      planned,
      overMonths,
    })
  }
  return out.sort((a, b) => b.thisMonth - a.thisMonth)
}

/** The last value against the one before it and against the median of up to three before it (from `used` months). */
function against(series: number[], used: boolean[]): { last: number | null; usual: number | null } {
  const k = series.length - 1
  const earlier: number[] = []
  for (let i = Math.max(0, k - 3); i < k; i++) if (used[i]) earlier.push(series[i])
  return { last: k >= 1 ? series[k - 1] : null, usual: earlier.length ? median(earlier) : null }
}

export interface SpendTrend {
  thisMonth: number
  last: number | null
  usual: number | null
  planned: number
}

/** All spending outside savings in `month` (so far, in the current month) against the month before and a typical month. */
export function spendingTrend(ix: Index, month: string, today: string): SpendTrend {
  const current = monthOf(today)
  const months = windowMonths(ix, month, 4)
  const days = daysInMonth(month)
  const elapsed = month === current ? dayOfMonth(today) : days
  const ids = spendIds(ix)
  const series = months.map((m) => {
    let s = 0
    for (const v of spentThrough(ix, m, m === month ? elapsed : samePoint(m, elapsed, days), ids).values()) s += v
    return s
  })
  return {
    thisMonth: series[series.length - 1],
    ...against(series, months.map(() => true)),
    planned: totalPlanned(monthView(ix, month, current)),
  }
}

// ---------------------------------------------------------------- weeks and days

export interface WeekPoint {
  /** Monday the week starts on */
  start: string
  spent: number
}

/**
 * Everyday spending per week (Monday to Sunday) for the last `n` weeks, oldest first, the current partial week last.
 * Weeks that ended before the first transaction are left out; the current week is always there.
 */
export function weeks(ix: Index, today: string, n = 8): WeekPoint[] {
  const { ids } = everydayIds(ix)
  const thisMonday = mondayOf(today)
  const count = Math.max(1, n)
  const out: WeekPoint[] = []
  for (let i = count - 1; i >= 0; i--) out.push({ start: addDays(thisMonday, -7 * i), spent: 0 })
  const from = out[0].start
  for (const t of ix.txns) {
    if (t.date > today) continue
    if (t.date < from) break
    if (t.cat === RTA || !ids.has(t.cat)) continue
    out[Math.floor(dayDiff(from, t.date) / 7)].spent -= t.base
  }
  const earliest = earliestDate(ix)
  return out.filter((w, i) => i === out.length - 1 || (earliest !== null && addDays(w.start, 6) >= earliest))
}

export interface DayPoint {
  date: string
  spent: number
}

/**
 * Spending in the daily categories per day for the last `n` days, oldest first, today last.
 * Days before the first transaction are left out. Empty when no category is daily.
 */
export function lastDays(ix: Index, today: string, n = 14): DayPoint[] {
  const everyday = everydayIds(ix)
  if (!everyday.daily) return []
  const from = addDays(today, -(Math.max(1, n) - 1))
  const out: DayPoint[] = []
  for (let d = from; d <= today; d = addDays(d, 1)) out.push({ date: d, spent: 0 })
  for (const t of ix.txns) {
    if (t.date > today) continue
    if (t.date < from) break
    if (everyday.ids.has(t.cat)) out[dayDiff(from, t.date)].spent -= t.base
  }
  const earliest = earliestDate(ix)
  return out.filter((d, i) => i === out.length - 1 || (earliest !== null && d.date >= earliest))
}

// ---------------------------------------------------------------- sentences

export interface Insight {
  tone: 'good' | 'bad' | 'neutral'
  text: string
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Up to four short sentences that say what the month means, most important first, each category named once.
 * In the current month they lead to something to do. Empty when there is nothing meaningful to say yet
 * (no data, or a month that hasn't started).
 */
export function insights(ix: Index, month: string, today: string): Insight[] {
  const current = monthOf(today)
  const first = ix.months[0]
  if (!first || month > current || month < first) return []

  const base = ix.settings.base
  const money = (v: number) => fmt(Math.round(v / 100) * 100, base)
  const isCurrent = month === current
  const days = daysInMonth(month)
  const elapsed = isCurrent ? dayOfMonth(today) : days
  const view = monthView(ix, month, current)
  const ids = spendIds(ix)
  const plan = totalPlanned(view)
  const spendCats = view.cats.filter((c) => !c.cat.saving)
  const prevMonth = addMonths(month, -1)
  const hasPrev = prevMonth >= first
  const mentioned = new Set<ID>()
  // spending already logged for later this month doesn't count as "so far"
  const later = new Map<ID, number>()
  if (isCurrent) {
    for (const t of ix.txns) {
      if (t.date <= today) break
      if (monthOf(t.date) === month) later.set(t.cat, (later.get(t.cat) ?? 0) - t.base)
    }
  }
  const spentSoFar = (c: CatMonth) => -c.activity - (later.get(c.cat.id) ?? 0)
  const meaningful = (diff: number, scale: number) => Math.abs(diff) >= Math.max(100, Math.round(scale * 0.02))

  const views = new Map<string, MonthView>([[month, view]])
  const viewOf = (m: string) => {
    let v = views.get(m)
    if (!v) views.set(m, (v = monthView(ix, m, current)))
    return v
  }
  const recent = windowMonths(ix, month, 3)
  /** ", 3 months in a row" when a category went over in this month and the ones just before it */
  const streak = (id: ID) => {
    let k = 1
    for (let i = recent.length - 2; i >= 0; i--) {
      const p = viewOf(recent[i]).byId.get(id)
      if (p && wentOver(p)) k++
      else break
    }
    return k >= 2 ? `, ${k} months in a row` : ''
  }

  // -- categories below zero: this month's own overspending, then debt still uncovered from earlier months.
  //    In the current month the last of these says how to clear the red numbers Plan shows.
  const shortfalls = (): Insight[] => {
    const out: Insight[] = []
    const parts = spendCats.map((c) => ({ c, ...shortfall(c) }))
    const over = parts.filter((p) => p.own >= 100 && !mentioned.has(p.c.cat.id)).sort((a, b) => b.own - a.own)
    const owed = isCurrent ? parts.filter((p) => p.own < 100 && p.carried >= 100).sort((a, b) => b.carried - a.carried) : []
    const named = (ps: typeof parts, total: number, verb: string, plural: string) =>
      ps.length <= 2
        ? `${list(ps.map((p) => p.c.cat.name))} ${ps.length === 1 ? verb : plural} ${money(total)}`
        : `${ps.length} categories ${plural} ${money(total)}`
    let said = 0
    if (over.length) {
      over.forEach((p) => mentioned.add(p.c.cat.id))
      const own = over.reduce((s, p) => s + p.own, 0)
      const most = over.length > 2 ? `, most in ${over[0].c.cat.name}` : ''
      // in the current month the amount matches Plan's red number, older debt included
      const older = isCurrent ? over.reduce((s, p) => s + p.carried, 0) : 0
      said = own + older
      let text: string
      if (older >= 100) {
        text = `${named(over, own + older, 'is', 'are')} short, ${money(own)} of it this month${most}`
      } else {
        const tail = over.length === 1 ? streak(over[0].c.cat.id) : most
        text = `${named(over, own, isCurrent ? 'is' : 'went', isCurrent ? 'are' : 'went')} over plan${tail}`
      }
      out.push({ tone: 'bad', text })
    }
    if (owed.length) {
      owed.forEach((p) => mentioned.add(p.c.cat.id))
      const total = owed.reduce((s, p) => s + p.carried, 0)
      said = total
      const most = owed.length > 2 ? `, most in ${owed[0].c.cat.name}` : ''
      out.push({ tone: 'bad', text: `${named(owed, total, 'is still', 'are still')} short from earlier months${most}` })
    }
    if (!out.length) return out
    if (isCurrent) {
      // what it takes to bring every red category in Plan back to zero
      const need = parts.reduce((s, p) => s + (p.own >= 100 || p.carried >= 100 ? p.own + p.carried : 0), 0)
      const it = out.length === 1 && need === said ? 'it' : money(need)
      const rta = view.readyToAssign
      const action =
        rta >= need
          ? `cover ${it} from Ready to assign`
          : rta >= 100
            ? `Ready to assign covers ${money(rta)} of ${it}`
            : `cover ${it} from another category`
      out[out.length - 1].text += `; ${action}`
    }
    for (const n of out) n.text += '.'
    return out
  }

  // -- day to day: the daily categories' average so far against their plan, and what a day can take from now
  const dayToDay = (): Insight | null => {
    if (!isCurrent) return null
    const d = daily(ix, view, today)
    if (!d || d.available <= 0 || d.cats.some((c) => mentioned.has(c.id))) return null
    d.cats.forEach((c) => mentioned.add(c.id))
    const one = d.cats.length === 1
    const names = list(d.cats.map((c) => c.name))
    // the same figure Today shows: what's left spread over the days left, today included
    const perDayLeft = d.daysLeft > 1 && d.allowance >= 100
    if (elapsed < SETTLED) {
      return perDayLeft ? { tone: 'neutral', text: `${names} ${one ? 'has' : 'have'} ${money(d.allowance)} a day for the rest of ${monthName(month)}.` } : null
    }
    const left = perDayLeft
      ? `${money(d.allowance)} a day is left`
      : `${money(d.available)} is left for ${d.daysLeft > 1 ? `${d.daysLeft} days` : 'today'}`
    const cms = d.cats.map((c) => view.byId.get(c.id)!)
    const soFar = cms.reduce((s, c) => s + spentSoFar(c), 0)
    const perDay = cms.reduce((s, c) => s + plannedOf(c), 0) / days
    if (soFar <= 0) return { tone: 'neutral', text: `Nothing logged in ${names} yet; ${left}.` }
    const avg = soFar / elapsed
    const average = `${names} ${one ? 'averages' : 'average'} ${money(avg)} a day`
    const its = `${one ? 'its' : 'their'} ${money(perDay)} plan`
    if (Math.abs(avg - perDay) < Math.max(100, perDay * 0.05)) return { tone: 'neutral', text: `${average}, right on ${its}.` }
    if (avg > perDay) {
      const keep = perDayLeft
        ? `keep ${one ? 'it' : 'them'} to ${money(d.allowance)} a day`
        : d.daysLeft > 1
          ? `${money(d.available)} has to last ${d.daysLeft} days`
          : left
      return { tone: 'bad', text: `${average}, over ${its}; ${keep}.` }
    }
    return { tone: 'good', text: `${average}, under ${its}, so ${left}.` }
  }

  // -- the whole month against its plan (past months)
  const versusPlan = (): Insight | null => {
    if (isCurrent || plan <= 0 || view.spent <= 0) return null
    const diff = view.spent - plan
    // "Right on plan" can't stand next to a category that went over: that sentence says it alone.
    if (!meaningful(diff, plan)) return spendCats.some((c) => shortfall(c).own >= 100) ? null : { tone: 'good', text: `You spent ${money(view.spent)}, right on plan.` }
    if (diff < 0) return { tone: 'good', text: `You spent ${money(view.spent)}, ${money(-diff)} less than planned.` }
    // when the whole difference is one or two categories' overspending, name them here instead of saying it twice
    const over = spendCats.filter((c) => shortfall(c).own >= 100)
    const own = over.reduce((s, c) => s + shortfall(c).own, 0)
    let where = ''
    if (over.length && money(own) === money(diff)) {
      over.sort((a, b) => shortfall(b).own - shortfall(a).own).forEach((c) => mentioned.add(c.cat.id))
      where =
        over.length === 1
          ? `, all in ${over[0].cat.name}${streak(over[0].cat.id)}`
          : over.length === 2
            ? `, in ${list(over.map((c) => c.cat.name))}`
            : `, across ${over.length} categories, most in ${over[0].cat.name}`
    }
    return { tone: 'bad', text: `You spent ${money(view.spent)}, ${money(diff)} more than planned${where}.` }
  }

  // -- a finished month in which a category spent much less than it usually does.
  //    More than usual is only news when it wasn't planned, and then it's already named as overspending.
  //    Not for the current month: the daily sentence speaks for everyday spending, and the rest is lumpy,
  //    so low mostly means the purchase hasn't happened yet.
  const unusual = (): Insight | null => {
    const earlier = windowMonths(ix, month, 4).slice(0, -1)
    if (!earlier.length) return null
    const scale = Math.max(plan, view.spent)
    let best: { name: string; now: number; usual: number; k: number; id: ID } | null = null
    for (const c of spendCats) {
      if (c.cat.archived || mentioned.has(c.cat.id)) continue
      const withData = earlier.filter((m) => ix.act.get(m)?.has(c.cat.id))
      if (!withData.length) continue
      const usual = withData.reduce((s, m) => s - (ix.act.get(m)!.get(c.cat.id) ?? 0), 0) / withData.length
      const now = -c.activity
      if (usual < 100 * 10 || usual < scale * 0.03) continue
      if (now / usual > 0.75) continue
      if (usual - now < scale * 0.03) continue
      if (!best || usual - now > best.usual - best.now) best = { name: c.cat.name, now, usual, k: withData.length, id: c.cat.id }
    }
    if (!best) return null
    mentioned.add(best.id)
    const ref = best.k === 1 ? `in ${monthName(prevMonth)}` : `your ${best.k}-month average`
    return { tone: 'good', text: `${best.name} was ${Math.round((1 - best.now / best.usual) * 100)}% lower than ${ref}.` }
  }

  // -- this week's everyday spending against the same days of last week
  const week = (): Insight | null => {
    if (!isCurrent) return null
    const everyday = everydayIds(ix)
    const monday = mondayOf(today)
    const dow = dayDiff(monday, today)
    const thisWeek = spentBetween(ix, monday, today, everyday.ids)
    const lastWeek = spentBetween(ix, addDays(monday, -7), addDays(today, -7), everyday.ids)
    if (thisWeek <= 0) return null
    if (spentBetween(ix, '0000-00-00', addDays(monday, -1), everyday.ids) <= 0 && lastWeek <= 0) return null
    const full = dow === 6
    const lead = everyday.daily
      ? `Everyday spending ${full ? 'was' : 'is'} ${money(thisWeek)} this week`
      : `This week you${full ? '' : '’ve'} spent ${money(thisWeek)}`
    const than = full ? 'last week' : 'by this day last week'
    const diff = thisWeek - lastWeek
    if (!meaningful(diff, Math.max(thisWeek, lastWeek) * 2.5)) return { tone: 'neutral', text: `${lead}, about the same as ${than}.` }
    return diff < 0
      ? { tone: 'good', text: `${lead}, ${money(-diff)} less than ${than}.` }
      : { tone: 'bad', text: `${lead}, ${money(diff)} more than ${than}.` }
  }

  // -- savings rate against the target
  const savings = (): Insight | null => {
    const income = view.income
    const saved = view.saved
    if (saved < 0) return { tone: 'bad', text: `You took ${money(-saved)} out of savings${isCurrent ? ' this month' : ''}.` }
    if (saved > 0 && saved > income) {
      // the starting balance or money from earlier months paid for it: a rate would read above 100%
      const what = isCurrent ? `You’ve set aside ${money(saved)} for savings` : `You set aside ${money(saved)} for savings`
      const more = income > 0 ? `, more than ${isCurrent ? 'this month’s' : `${monthName(month)}’s`} income` : isCurrent ? ' this month' : ''
      return { tone: 'good', text: `${what}${more}.` }
    }
    if (income <= 0) return null
    const target = ix.settings.savingsTarget || 0
    const rate = saved / income
    const t = pct(target)
    if (isCurrent) {
      if (target > 0 && rate + 0.005 < target) {
        const goal = Math.round(income * target)
        return saved > 0
          ? { tone: 'neutral', text: `Saving ${t} of this month’s income means ${money(goal)}; ${money(goal - saved)} to go.` }
          : { tone: 'neutral', text: `Saving ${t} of this month’s income means setting aside ${money(goal)}.` }
      }
      if (saved <= 0) return null
      return { tone: 'good', text: `You’ve saved ${pct(rate)} of this month’s income${target > 0 ? `. Your target is ${t}` : ''}.` }
    }
    if (target <= 0) return { tone: saved > 0 ? 'good' : 'neutral', text: `You saved ${pct(rate)} of your income.` }
    return { tone: rate + 0.005 >= target ? 'good' : 'bad', text: `You saved ${pct(rate)} of your income. Your target is ${t}.` }
  }

  // -- a finished month against the one before
  const versusLast = (): Insight | null => {
    if (isCurrent || !hasPrev) return null
    const prev = spendingByDay(ix, prevMonth, ids)
    if (!prev.count) return null
    const before = prev.days.reduce((s, v) => s + v, 0)
    const diff = view.spent - before
    if (before <= 0 || !meaningful(diff, Math.max(plan, before))) return null
    const prevName = monthName(prevMonth)
    return diff < 0
      ? { tone: 'good', text: `Spending was ${money(-diff)} lower than in ${prevName}.` }
      : { tone: view.spent > plan ? 'bad' : 'neutral', text: `Spending was ${money(diff)} higher than in ${prevName}.` }
  }

  // Categories that keep going over are left to advice() (compare.ts), which can say what plan would fit.
  const order: (() => Insight | Insight[] | null)[] = isCurrent
    ? [shortfalls, dayToDay, week, savings]
    : [savings, versusPlan, shortfalls, unusual, versusLast]
  const out: Insight[] = []
  for (const make of order) {
    if (out.length >= 4) break
    const n = make()
    if (Array.isArray(n)) out.push(...n.slice(0, 4 - out.length))
    else if (n) out.push(n)
  }
  return out
}
