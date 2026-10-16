// The analytics behind Review: plain numbers and sentences that say what the budget means.
// Pure functions over the Index. All amounts are integer minor units in the base currency.

import { monthView, type CatMonth, type Index, type MonthView } from './budget'
import { addDays, addMonths, dayOfMonth, daysInMonth, monthName, monthOf } from './dates'
import { fmt } from './money'
import { RTA, type ID } from './types'

// ---------------------------------------------------------------- helpers

/** Non-saving categories (archived included, so history still adds up). */
function spendIds(ix: Index): Set<ID> {
  const ids = new Set<ID>()
  for (const c of ix.cats) if (!c.saving) ids.add(c.id)
  return ids
}

/** What a category had to spend at the start of the month: carry + assigned, never below zero. */
function plannedOf(c: CatMonth): number {
  return Math.max(0, c.carry + c.assigned)
}

function totalPlanned(view: MonthView): number {
  let s = 0
  for (const c of view.cats) if (!c.cat.saving) s += plannedOf(c)
  return s
}

/** Did this month's own spending push the category below zero? Debt carried in from earlier doesn't count. */
function wentOver(c: CatMonth): boolean {
  return c.available < 0 && Math.max(0, c.carry) + c.assigned + c.activity < 0
}

/** Spending per day of `month` (index 0 = day 1), positive numbers, non-saving categories only. */
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

/** Spending between two dates inclusive, non-saving categories, positive. */
function spentBetween(ix: Index, from: string, to: string, ids: Set<ID>): number {
  let s = 0
  for (const t of ix.txns) {
    if (t.date > to) continue
    if (t.date < from) break // newest first
    if (t.cat !== RTA && ids.has(t.cat)) s -= t.base
  }
  return s
}

// ---------------------------------------------------------------- months

export interface MonthPoint {
  month: string
  income: number
  /** spending outside savings categories, positive */
  spent: number
  /** money given to savings categories */
  saved: number
  savingsRate: number | null
  /** what non-saving categories had to spend at the start of the month (Σ max(0, carry + assigned)) */
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
      savingsRate: v.savingsRate,
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
  /** cumulative spending; index 0 = end of day 1; null after today */
  actual: (number | null)[]
  /** the previous month's cumulative curve stretched to `days` points; empty when it had no spending */
  previous: number[]
}

export function burn(ix: Index, month: string, today: string): Burn {
  const current = monthOf(today)
  const days = daysInMonth(month)
  const ids = spendIds(ix)
  const cut = month < current ? days : month > current ? 0 : dayOfMonth(today)
  const cum = cumulative(spendingByDay(ix, month, ids).days)
  const prev = spendingByDay(ix, addMonths(month, -1), ids)
  return {
    month,
    days,
    today: month < current ? null : cut,
    plan: totalPlanned(monthView(ix, month, current)),
    actual: cum.map((v, i) => (i < cut ? v : null)),
    previous: prev.count ? resample(cumulative(prev.days), days) : [],
  }
}

// ---------------------------------------------------------------- categories

export interface CatTrend {
  id: string
  name: string
  /** spending per month, oldest first, ending at `month` (months before any data are left out) */
  series: number[]
  thisMonth: number
  /** mean spending over the earlier months in the window that had activity in this category */
  average: number
  /** carry + assigned this month, never below zero */
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
export function categoryTrends(ix: Index, month: string, current: string, n = 6): CatTrend[] {
  const months = windowMonths(ix, month, n)
  const views = months.map((m) => monthView(ix, m, current))
  const now = views[views.length - 1]
  const out: CatTrend[] = []
  for (const cat of ix.cats) {
    if (cat.saving || cat.archived) continue
    const series = months.map((m) => 0 - (ix.act.get(m)?.get(cat.id) ?? 0))
    const cm = now.byId.get(cat.id)
    const planned = cm ? plannedOf(cm) : 0
    if (!planned && series.every((v) => v === 0)) continue
    let total = 0
    let count = 0
    for (let i = 0; i < months.length - 1; i++) {
      if (ix.act.get(months[i])?.has(cat.id)) {
        total += series[i]
        count++
      }
    }
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
      planned,
      overMonths,
    })
  }
  return out.sort((a, b) => b.thisMonth - a.thisMonth)
}

// ---------------------------------------------------------------- weeks

export interface WeekPoint {
  /** Monday the week starts on */
  start: string
  spent: number
}

/**
 * Spending per week (Monday to Sunday) for the last `n` weeks, oldest first, the current partial week last.
 * Weeks that ended before the first transaction are left out; the current week is always there.
 */
export function weeks(ix: Index, today: string, n = 8): WeekPoint[] {
  const ids = spendIds(ix)
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
  const earliest = ix.txns.length ? ix.txns[ix.txns.length - 1].date : null
  return out.filter((w, i) => i === out.length - 1 || (earliest !== null && addDays(w.start, 6) >= earliest))
}

// ---------------------------------------------------------------- sentences

export interface Insight {
  tone: 'good' | 'bad' | 'neutral'
  text: string
}

/** Round an estimate to two significant figures (whole units at least): 3,789 → 3,800. */
function roughly(minor: number): number {
  const major = Math.abs(minor) / 100
  if (major < 100) return Math.sign(minor) * Math.round(major) * 100
  const step = 10 ** (Math.floor(Math.log10(major)) - 1)
  return Math.sign(minor) * Math.round(major / step) * step * 100
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Two to four short sentences that say what the month means, most important first.
 * Empty when there is nothing meaningful to say yet (no data, or a month that hasn't started).
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

  // How many months in a row (ending at `month`) a category went over.
  const views = new Map<string, MonthView>([[month, view]])
  const viewOf = (m: string) => {
    let v = views.get(m)
    if (!v) views.set(m, (v = monthView(ix, m, current)))
    return v
  }
  const recent = windowMonths(ix, month, 3)

  // -- categories over plan right now
  const overspent = (): Insight | null => {
    const over = spendCats.filter((c) => wentOver(c) && -c.available >= 100).sort((a, b) => a.available - b.available)
    if (!over.length) return null
    over.forEach((c) => mentioned.add(c.cat.id))
    const is = isCurrent ? 'is' : 'went'
    if (over.length === 1) {
      const c = over[0]
      let streak = 1
      for (let i = recent.length - 2; i >= 0; i--) {
        const p = viewOf(recent[i]).byId.get(c.cat.id)
        if (p && wentOver(p)) streak++
        else break
      }
      const tail = streak >= 2 ? `, ${streak} months in a row` : ''
      return { tone: 'bad', text: `${c.cat.name} ${is} ${money(-c.available)} over plan${tail}.` }
    }
    const total = over.reduce((s, c) => s - c.available, 0)
    const text =
      over.length === 2
        ? `${list(over.map((c) => c.cat.name))} ${isCurrent ? 'are' : 'went'} ${money(total)} over plan.`
        : `${over.length} categories ${isCurrent ? 'are' : 'went'} ${money(total)} over plan, most in ${over[0].cat.name}.`
    return { tone: 'bad', text }
  }

  // -- where daily spending is heading (current month, after the first week)
  const pace = (): Insight | null => {
    if (!isCurrent || elapsed < 7 || elapsed >= days || plan <= 0) return null
    let dailyDiff = 0
    let lumpDiff = 0
    let hasDaily = false
    for (const c of spendCats) {
      const spent = spentSoFar(c)
      const planned = plannedOf(c)
      if (c.cat.daily && !c.cat.archived) {
        hasDaily = true
        dailyDiff += Math.max(spent, Math.round((spent * days) / elapsed)) - planned
      } else {
        lumpDiff += Math.max(0, spent - planned)
      }
    }
    if (!hasDaily || !meaningful(dailyDiff, plan)) return null
    const diff = dailyDiff + lumpDiff
    if (!meaningful(diff, plan)) return { tone: 'neutral', text: 'At this pace you’ll end the month right on plan.' }
    return diff > 0
      ? { tone: 'bad', text: `At this pace you’ll go ${money(roughly(diff))} over plan this month.` }
      : { tone: 'good', text: `At this pace you’ll end the month ${money(roughly(-diff))} under plan.` }
  }

  // -- the whole month against its plan (past months)
  const versusPlan = (): Insight | null => {
    if (isCurrent || plan <= 0 || view.spent <= 0) return null
    const diff = view.spent - plan
    if (!meaningful(diff, plan)) return { tone: 'good', text: `You spent ${money(view.spent)}, right on plan.` }
    return diff > 0
      ? { tone: 'bad', text: `You spent ${money(view.spent)}, ${money(diff)} more than planned.` }
      : { tone: 'good', text: `You spent ${money(view.spent)}, ${money(-diff)} less than planned.` }
  }

  // -- the category that moved most against its own history
  const unusual = (): Insight | null => {
    const earlier = windowMonths(ix, month, 4).slice(0, -1)
    if (!earlier.length) return null
    // spending per category through the comparable day of each earlier month
    const through = new Map<string, Map<ID, number>>()
    for (const m of earlier) {
      const limit = isCurrent ? Math.round((elapsed * daysInMonth(m)) / days) : 31
      const sums = new Map<ID, number>()
      for (const t of ix.txns) {
        if (monthOf(t.date) !== m || !ids.has(t.cat) || dayOfMonth(t.date) > limit) continue
        sums.set(t.cat, (sums.get(t.cat) ?? 0) - t.base)
      }
      through.set(m, sums)
    }
    const scale = Math.max(plan, view.spent)
    let best: { name: string; now: number; usual: number; k: number; id: ID } | null = null
    for (const c of spendCats) {
      if (c.cat.archived || mentioned.has(c.cat.id)) continue
      const withData = earlier.filter((m) => ix.act.get(m)?.has(c.cat.id))
      if (!withData.length) continue
      const usual = withData.reduce((s, m) => s + (through.get(m)!.get(c.cat.id) ?? 0), 0) / withData.length
      const now = spentSoFar(c)
      if (usual < 100 * 10 || usual < scale * 0.03) continue
      const ratio = now / usual
      if (ratio > 0.75 && ratio < 1.25) continue
      // mid-month, a lumpy category being low mostly means the purchase hasn't happened yet
      if (isCurrent && ratio < 1 && !c.cat.daily) continue
      if (Math.abs(now - usual) < scale * 0.03) continue
      if (!best || Math.abs(now - usual) > Math.abs(best.now - best.usual)) best = { name: c.cat.name, now, usual, k: withData.length, id: c.cat.id }
    }
    if (!best) return null
    mentioned.add(best.id)
    const ratio = best.now / best.usual
    const verb = isCurrent ? 'is' : 'was'
    const prevName = monthName(addMonths(month, -1))
    const single = best.k === 1
    let text: string
    if (ratio >= 2) {
      const times = `${Math.round(ratio * 10) / 10}×`
      const ref = isCurrent
        ? single ? `what it was at this point in ${prevName}` : 'your usual for this point in the month'
        : single ? `what it was in ${prevName}` : `your ${best.k}-month average`
      text = `${best.name} ${verb} ${times} ${ref}.`
    } else {
      const change = `${Math.round(Math.abs(ratio - 1) * 100)}% ${ratio > 1 ? 'higher' : 'lower'} than`
      const ref = isCurrent
        ? single ? `at this point in ${prevName}` : 'usual for this point in the month'
        : single ? `in ${prevName}` : `your ${best.k}-month average`
      text = `${best.name} ${verb} ${change} ${ref}.`
    }
    return { tone: ratio > 1 ? 'bad' : 'good', text }
  }

  // -- this week against the same days of last week
  const week = (): Insight | null => {
    if (!isCurrent) return null
    const monday = mondayOf(today)
    const dow = dayDiff(monday, today)
    const thisWeek = spentBetween(ix, monday, today, ids)
    const lastWeek = spentBetween(ix, addDays(monday, -7), addDays(today, -7), ids)
    if (thisWeek <= 0) return null
    if (spentBetween(ix, '0000-00-00', addDays(monday, -1), ids) <= 0 && lastWeek <= 0) return null
    const full = dow === 6
    const lead = full ? `This week you spent ${money(thisWeek)}` : `This week you’ve spent ${money(thisWeek)}`
    const than = full ? 'last week' : 'by this day last week'
    const diff = thisWeek - lastWeek
    if (!meaningful(diff, Math.max(thisWeek, lastWeek) * 2.5)) return { tone: 'neutral', text: `${lead}, about the same as ${than}.` }
    return diff < 0
      ? { tone: 'good', text: `${lead}, ${money(-diff)} less than ${than}.` }
      : { tone: 'bad', text: `${lead}, ${money(diff)} more than ${than}.` }
  }

  // -- categories that keep going over
  const repeat = (): Insight | null => {
    if (recent.length < 2) return null
    let best: { name: string; k: number; spent: number } | null = null
    for (const c of spendCats) {
      if (c.cat.archived || mentioned.has(c.cat.id)) continue
      let k = 0
      for (const m of recent) {
        const p = viewOf(m).byId.get(c.cat.id)
        if (p && wentOver(p)) k++
      }
      if (k < 2) continue
      if (!best || k > best.k || (k === best.k && -c.activity > best.spent)) best = { name: c.cat.name, k, spent: -c.activity }
    }
    if (!best) return null
    const n = recent.length
    return best.k === n
      ? { tone: 'bad', text: `${best.name} went over plan ${n} months in a row; it may need a bigger plan.` }
      : { tone: 'bad', text: `${best.name} went over plan in ${best.k} of the last ${n} months.` }
  }

  // -- savings rate against the target
  const savings = (): Insight | null => {
    const income = view.income
    if (income <= 0) return null
    const target = ix.settings.savingsTarget || 0
    const saved = view.saved
    if (saved < 0) return { tone: 'bad', text: `You took ${money(-saved)} out of savings${isCurrent ? ' this month' : ''}.` }
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

  // -- this month against last month
  const versusLast = (): Insight | null => {
    if (!hasPrev) return null
    const prev = spendingByDay(ix, prevMonth, ids)
    if (!prev.count) return null
    const prevName = monthName(prevMonth)
    if (isCurrent) {
      if (elapsed < 3) return null
      const sofar = cumulative(spendingByDay(ix, month, ids).days)[elapsed - 1]
      const then = resample(cumulative(prev.days), days)[elapsed - 1]
      const diff = sofar - then
      if (!meaningful(diff, Math.max(plan, then * 2))) return null
      return diff < 0
        ? { tone: 'good', text: `Spending so far is ${money(-diff)} lower than by this day in ${prevName}.` }
        : { tone: 'bad', text: `Spending so far is ${money(diff)} higher than by this day in ${prevName}.` }
    }
    const before = prev.days.reduce((s, v) => s + v, 0)
    const diff = view.spent - before
    if (before <= 0 || !meaningful(diff, Math.max(plan, before))) return null
    return diff < 0
      ? { tone: 'good', text: `Spending was ${money(-diff)} lower than in ${prevName}.` }
      : { tone: 'bad', text: `Spending was ${money(diff)} higher than in ${prevName}.` }
  }

  const order = isCurrent
    ? [overspent, pace, repeat, unusual, week, savings, versusLast]
    : [savings, versusPlan, overspent, repeat, unusual, versusLast]
  const out: Insight[] = []
  for (const make of order) {
    if (out.length >= 4) break
    const n = make()
    if (n) out.push(n)
  }
  return out
}
