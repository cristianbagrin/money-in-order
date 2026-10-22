// A month against its usual for Review: where the money went, what stands out, income by source, goals.
// "Usual" is the average of the three months before (or as many as there is data for); while a month runs
// both sides are counted up to the same point of the month. Pure functions over the Index; integer minor units.

import { monthView, type Index, type MonthView } from './budget'
import { addMonths, dayOfMonth, daysInMonth, monthDiff, monthName, monthOf } from './dates'
import { median, plannedOf, setAside, totalPlanned, wentOver } from './insights'
import { fmt } from './money'
import { RTA, type ID } from './types'

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)

/** The months `month` is compared with: up to `n` before it, none before the first month with data. */
export function usualMonths(ix: Index, month: string, n = 3): string[] {
  const first = ix.months[0]
  const out: string[] = []
  if (!first) return out
  for (let i = n; i >= 1; i--) {
    const m = addMonths(month, -i)
    if (m >= first) out.push(m)
  }
  return out
}

/** A number you would plan with: steps of a twentieth of its leading power of ten (17,234 → 17,500; 1,234 → 1,250). */
export function roundPlan(minor: number, how: 'up' | 'down' | 'near' = 'up'): number {
  if (minor <= 0) return 0
  const v = minor / 100
  const step = Math.max(1, 10 ** Math.floor(Math.log10(v)) / 20)
  const r = how === 'up' ? Math.ceil(v / step - 1e-9) : how === 'down' ? Math.floor(v / step + 1e-9) : Math.round(v / step)
  return r * step * 100
}

/** Too small a difference to call a change. */
export function same(diff: number, scale: number): boolean {
  return Math.abs(diff) < Math.max(100, Math.abs(scale) * 0.03)
}

// ---------------------------------------------------------------- where it went

export interface CatSpend {
  id: ID
  name: string
  /** spent this month (so far), positive */
  spent: number
  /** the usual by the same point; null with no earlier month */
  usual: number | null
  /** planned spending this month, see plannedOf() */
  planned: number
  /** months in a row, newest first, whose own spending pushed it below zero: ending this month, or last month while this one runs and isn't over yet */
  overMonths: string[]
}

export interface MonthSpend {
  month: string
  /** still going: amounts are up to `day`, the usual up to the same point of its months */
  running: boolean
  day: number
  spent: number
  usual: number | null
  planned: number
  /** the months the usual is the average of */
  months: string[]
  /** biggest first; categories with nothing this month only when they usually take a real share */
  cats: CatSpend[]
}

export function spending(ix: Index, month: string, today: string): MonthSpend {
  const current = monthOf(today)
  const running = month === current
  const days = daysInMonth(month)
  const day = running ? dayOfMonth(today) : days
  const months = usualMonths(ix, month)
  // the day of each month that matches `day` of this one, by the share of the month gone
  const limit = new Map<string, number>([[month, day], ...months.map((m): [string, number] => [m, Math.round((day * daysInMonth(m)) / days)])])
  const sums = new Map<string, Map<ID, number>>([...limit.keys()].map((m) => [m, new Map()]))
  const ids = new Set(ix.cats.filter((c) => !c.saving).map((c) => c.id))
  const from = months[0] ?? month
  for (const t of ix.txns) {
    const m = monthOf(t.date)
    if (m < from) break // newest first
    if (t.cat === RTA || !ids.has(t.cat)) continue
    const lim = limit.get(m)
    if (lim === undefined || dayOfMonth(t.date) > lim) continue
    const s = sums.get(m)!
    s.set(t.cat, (s.get(t.cat) ?? 0) - t.base)
  }
  const total = (m: string) => [...sums.get(m)!.values()].reduce((s, v) => s + v, 0)
  const usualOf = (id: ID | null) => (months.length ? Math.round(mean(months.map((m) => (id ? sums.get(m)!.get(id) ?? 0 : total(m))))) : null)
  const usualTotal = usualOf(null)

  const views = new Map<string, MonthView>()
  const viewOf = (m: string) => {
    let v = views.get(m)
    if (!v) views.set(m, (v = monthView(ix, m, current)))
    return v
  }
  const view = viewOf(month)
  const first = ix.months[0] ?? month
  const overMonths = (id: ID) => {
    const over = (m: string) => {
      const c = viewOf(m).byId.get(id)
      return !!c && wentOver(c)
    }
    const out: string[] = []
    for (let m = running && !over(month) ? addMonths(month, -1) : month; out.length < 6 && m >= first && over(m); m = addMonths(m, -1)) out.push(m)
    return out
  }

  const now = sums.get(month)!
  const cats: CatSpend[] = []
  for (const cat of ix.cats) {
    if (cat.saving) continue
    const spent = now.get(cat.id) ?? 0
    const usual = usualOf(cat.id)
    if (spent <= 0 && (cat.archived || !usual || usual < Math.max(100, (usualTotal ?? 0) * 0.02))) continue
    const cm = view.byId.get(cat.id)
    cats.push({ id: cat.id, name: cat.name, spent, usual, planned: cm ? plannedOf(cm) : 0, overMonths: overMonths(cat.id) })
  }
  cats.sort((a, b) => b.spent - a.spent || (b.usual ?? 0) - (a.usual ?? 0))
  return { month, running, day, spent: total(month), usual: usualTotal, planned: totalPlanned(view), months, cats }
}

// ---------------------------------------------------------------- what stands out

export interface Insight {
  tone: 'good' | 'bad' | 'neutral'
  text: string
  cat: ID
}

/**
 * At most two sentences worth reading: a category that keeps going over (with what it really costs, so the plan
 * can be fixed), then the category that moved most against its usual. Nothing when nothing stands out.
 */
export function standouts(ix: Index, s: MonthSpend): Insight[] {
  const base = ix.settings.base
  const money = (v: number) => fmt(Math.round(v / 100) * 100, base)
  const is = s.running ? 'is' : 'was'
  const out: Insight[] = []

  // -- keeps going over: a plan problem, not a willpower one
  const repeat = s.cats
    .filter((c) => c.overMonths.length >= 2)
    .sort((a, b) => b.overMonths.length - a.overMonths.length || b.spent - b.planned - (a.spent - a.planned))[0]
  if (repeat) {
    // what it really cost in the finished months it went over, against what it was given
    const ms = repeat.overMonths.filter((m) => !(s.running && m === s.month))
    const given = (m: string) => ix.asg.get(m)?.get(repeat.id) ?? 0
    const cost = roundPlan(mean(ms.map((m) => -(ix.act.get(m)?.get(repeat.id) ?? 0))), 'near')
    const plan = s.running && given(s.month) > 0 ? given(s.month) : median(ms.map(given))
    // this month already plans for what it costs: nothing left to say
    if (!(s.running && plan >= cost && repeat.spent <= repeat.planned)) {
      const tail = cost - plan < Math.max(100, cost * 0.05) ? '' : `; it costs about ${money(cost)} a month${plan > 0 ? `, not ${money(plan)}` : ''}`
      out.push({ tone: 'bad', text: `${repeat.name} went over ${repeat.overMonths.length} months in a row${tail}.`, cat: repeat.id })
    }
  }

  // -- the biggest move against the usual
  if (s.usual !== null) {
    const scale = Math.max(s.usual, s.spent)
    let best: { c: CatSpend; diff: number } | null = null
    for (const c of s.cats) {
      if (c.usual === null || out.some((n) => n.cat === c.id)) continue
      const diff = c.spent - c.usual
      // a tenth of the month's spending, and a real change for the category
      if (Math.abs(diff) < Math.max(100 * 100, scale * 0.1)) continue
      if (c.usual > 0 && c.spent / c.usual < 1.3 && c.spent / c.usual > 0.7) continue
      if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { c, diff }
    }
    if (best) {
      const { c, diff } = best
      const ratio = c.usual ? c.spent / c.usual : Infinity
      let text: string
      if (diff < 0) text = `${c.name} ${is} ${money(-diff)} below usual.`
      else if (c.usual! < 100 * 100 || ratio >= 6) text = `${money(c.spent)} went to ${c.name}, usually next to nothing.`
      else if (ratio >= 1.9) text = `${c.name} ${is} ${ratio < 2.5 ? 'twice' : `${Math.round(ratio)} times`} its usual, ${money(c.spent)}.`
      else text = `${c.name} ${is} ${money(diff)} above usual.`
      out.push({ tone: diff < 0 ? 'good' : c.spent > c.planned ? 'bad' : 'neutral', text, cat: c.id })
    }
  }
  return out
}

// ---------------------------------------------------------------- income

export interface SourceIncome {
  /** null: income with no source (or one since deleted) */
  id: ID | null
  name: string
  amount: number
  /** the average of the usual months, whole months; null with no earlier month */
  usual: number | null
}

/** Income per source in `month` against the usual, in the sources' order. Empty without sources or income. */
export function incomeBySource(ix: Index, month: string): SourceIncome[] {
  const sources = ix.settings.sources ?? []
  if (!sources.length || !(ix.income.get(month) ?? 0)) return []
  const months = usualMonths(ix, month)
  const known = new Set(sources.map((s) => s.id))
  const sums = new Map<string, Map<ID | null, number>>([month, ...months].map((m) => [m, new Map()]))
  const from = months[0] ?? month
  for (const t of ix.txns) {
    const m = monthOf(t.date)
    if (m < from) break // newest first
    if (t.cat !== RTA || t.kind) continue
    const s = sums.get(m)
    if (!s) continue
    const id = t.src && known.has(t.src) ? t.src : null
    s.set(id, (s.get(id) ?? 0) + t.base)
  }
  const out: SourceIncome[] = []
  for (const { id, name } of [...sources, { id: null, name: 'Other' }]) {
    const amount = sums.get(month)!.get(id) ?? 0
    const usual = months.length ? Math.round(mean(months.map((m) => sums.get(m)!.get(id) ?? 0))) : null
    if (amount || usual) out.push({ id, name, amount, usual })
  }
  return out
}

// ---------------------------------------------------------------- goals

export interface GoalProgress {
  id: ID
  name: string
  /** money in the category at the end of the month (so far, in the current month) */
  saved: number
  amount: number
  by?: string
  /** money added per month lately, net of spending from it */
  pace: number
  /** the month the goal is reached at that pace; null when nothing is being added */
  eta: string | null
  /** what each month left until `by` needs, when there is a deadline */
  needed: number | null
  status: 'done' | 'on' | 'behind' | 'open'
}

/** Categories saving toward a goal, as of `month`: how far along, and when they get there. */
export function goals(ix: Index, month: string, today: string): GoalProgress[] {
  const current = monthOf(today)
  const first = ix.months[0]
  if (!first || month < first) return []
  const view = monthView(ix, month, current)
  // the last three months, the current one only once something was given to it
  const recent: string[] = []
  for (let i = 2; i >= 0; i--) {
    const m = addMonths(month, -i)
    if (m >= first) recent.push(m)
  }
  const out: GoalProgress[] = []
  for (const cat of ix.cats) {
    const t = cat.target
    if (!t || t.kind !== 'goal' || cat.archived || !setAside(cat) || t.amount <= 0) continue
    const ms = recent.filter((m) => m !== current || ix.asg.get(m)?.has(cat.id))
    const pace = Math.round(mean(ms.map((m) => (ix.asg.get(m)?.get(cat.id) ?? 0) + (ix.act.get(m)?.get(cat.id) ?? 0))))
    const saved = Math.max(0, view.byId.get(cat.id)?.available ?? 0)
    const missing = t.amount - saved
    const by = t.by
    const eta = missing > 0 && pace >= 100 ? addMonths(month, Math.ceil(missing / pace)) : null
    const needed = by && missing > 0 ? Math.ceil(missing / Math.max(1, monthDiff(month, by)) / 100) * 100 : null
    const status = missing <= 0 ? 'done' : by ? (eta && eta <= by ? 'on' : 'behind') : 'open'
    out.push({ id: cat.id, name: cat.name, saved, amount: t.amount, by, pace, eta, needed, status })
  }
  return out
}

/** One short line for a goal: reached, on pace, what it needs, or when it gets there. */
export function goalLine(g: GoalProgress, base: string, month: string): string {
  const name = (m: string) => monthName(m, { short: true, year: m.slice(0, 4) !== month.slice(0, 4) })
  if (g.status === 'done') return 'Reached'
  if (g.status === 'on') return `On pace for ${name(g.by!)}`
  if (g.status === 'behind') return `${fmt(g.needed!, base)} a month to make ${name(g.by!)}`
  return g.eta ? `${name(g.eta)} at this pace` : 'Nothing added lately'
}
