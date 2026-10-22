// Month against month for Review: what changed, what the last finished months say to change, and goals.
// Pure functions over the Index. All amounts are integer minor units in the base currency.

import { monthView, type Index, type MonthView } from './budget'
import { addMonths, monthDiff, monthName, monthOf } from './dates'
import { median, setAside, wentOver, type CatTrend, type Insight } from './insights'
import { fmt } from './money'
import type { Category, ID } from './types'

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)
const pct = (x: number) => `${Math.round(x * 100)}%`

/** Up to `n` finished months ending at `month`, or just before it while it is still going. */
export function settledMonths(ix: Index, month: string, today: string, n = 3): string[] {
  const current = monthOf(today)
  const first = ix.months[0]
  if (!first || month > current) return []
  const end = month < current ? month : addMonths(current, -1)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const m = addMonths(end, -i)
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

// ---------------------------------------------------------------- what changed

export type Basis = 'last' | 'usual'

export interface Change {
  /** the amount compared with, null when there is nothing to compare with */
  then: number | null
  diff: number
  /** too small to call a change */
  same: boolean
}

export function change(t: { thisMonth: number; last: number | null; usual: number | null }, basis: Basis): Change {
  const then = basis === 'last' ? t.last : t.usual
  if (then === null) return { then, diff: 0, same: true }
  const diff = t.thisMonth - then
  return { then, diff, same: Math.abs(diff) < Math.max(100, Math.max(t.thisMonth, then) * 0.03) }
}

/** Categories ordered by how much their spending moved against `basis`, the biggest change in money first. */
export function byChange(trends: CatTrend[], basis: Basis): CatTrend[] {
  const size = (t: CatTrend) => {
    const c = change(t, basis)
    return c.same ? 0 : Math.abs(c.diff)
  }
  return [...trends].sort((a, b) => size(b) - size(a) || b.thisMonth - a.thisMonth)
}

/** How many months before `month` there are to compare with (at most three). */
export function monthsBefore(ix: Index, month: string): number {
  const first = ix.months[0]
  if (!first) return 0
  return Math.max(0, Math.min(3, monthDiff(first, month)))
}

// ---------------------------------------------------------------- what to change

export interface Advice extends Insight {
  cat?: ID
}

export interface AdviceResult {
  /** the finished months the advice is drawn from */
  months: string[]
  items: Advice[]
  /** money a month the plans leave unused once the suggested changes are made; null without income to go on */
  free: number | null
}

/** The savings category most money went to in `views`, for naming where spare money could go. */
function savingsHome(ix: Index, views: MonthView[]): Category | null {
  let best: Category | null = null
  let most = -1
  for (const c of ix.cats) {
    if (!c.saving || c.archived) continue
    const given = views.reduce((s, v) => s + (v.byId.get(c.id)?.assigned ?? 0), 0)
    if (given > most) [best, most] = [c, given]
  }
  return best
}

/**
 * A few concrete changes the last finished months (up to three, at least two) point to, each with a number:
 * plans that keep proving too small (a plan problem, not a willpower one), plans that keep being too big,
 * and where the savings rate stands against the target given what is left over. Then, in the current month,
 * money still waiting in Ready to assign.
 */
export function advice(ix: Index, month: string, today: string): AdviceResult {
  const months = settledMonths(ix, month, today)
  if (months.length < 2) return { months, items: [], free: null }
  const current = monthOf(today)
  const base = ix.settings.base
  const money = (v: number) => fmt(Math.round(v / 100) * 100, base)
  const views = months.map((m) => monthView(ix, m, current))
  const n = months.length
  const earning = views.filter((v) => v.income > 0)
  const income = mean(earning.map((v) => v.income))
  // a change worth a sentence: 1% of income (or 2% of spending without income), never less than one unit
  const small = Math.max(100, income > 0 ? income * 0.01 : mean(views.map((v) => v.spent)) * 0.02)

  const raises: (Advice & { extra: number })[] = []
  const trims: (Advice & { spare: number })[] = []
  for (const cat of ix.cats) {
    if (cat.saving || cat.archived || setAside(cat)) continue
    const cms = views.map((v) => v.byId.get(cat.id))
    const spent = cms.map((c) => (c ? -c.activity : 0))
    const given = cms.map((c) => c?.assigned ?? 0)
    const plan = median(given)
    const over = cms.filter((c) => c && wentOver(c)).length
    if (over >= 2 && over >= n - 1) {
      const fit = roundPlan(median(spent))
      if (fit - plan < small) continue
      const when = over === n ? 'every month' : `${over} of ${n} months`
      const text =
        plan > 0
          ? `${cat.name} went over ${when}: it costs about ${money(roundPlan(median(spent), 'near'))}, not ${money(plan)}. Plan ${money(fit)}.`
          : `${cat.name} costs about ${money(roundPlan(median(spent), 'near'))} a month with nothing planned. Plan ${money(fit)}.`
      raises.push({ tone: 'bad', text, cat: cat.id, extra: fit - plan })
      continue
    }
    // a regular expense that used less than it got, every month
    if (cms.some((c, i) => !c || given[i] <= 0 || spent[i] <= 0 || spent[i] >= given[i])) continue
    const fit = roundPlan(Math.max(...spent))
    const spare = plan - fit
    if (spare < small) continue
    trims.push({
      tone: 'good',
      text: `${cat.name} used about ${money(roundPlan(median(spent), 'near'))} of its ${money(plan)} each month. Plan ${money(fit)} and ${money(spare)} a month is free.`,
      cat: cat.id,
      spare,
    })
  }
  raises.sort((a, b) => b.extra - a.extra)
  trims.sort((a, b) => b.spare - a.spare)

  const items: Advice[] = [...raises, ...trims].slice(0, 2)
  const home = savingsHome(ix, views)
  const homeName = home?.name ?? 'savings'

  // -- savings: the rate over these months, and what the plans leave to raise it
  let free: number | null = null
  if (earning.length >= 2) {
    const changes = raises.length + trims.length > 0
    const unassigned = mean(earning.map((v) => v.income - v.assigned))
    free = Math.round(unassigned + trims.reduce((s, t) => s + t.spare, 0) - raises.reduce((s, r) => s + r.extra, 0))
    const saved = mean(earning.map((v) => v.saved))
    const target = ix.settings.savingsTarget || 0
    const rate = saved / income
    const left = `about ${money(roundPlan(Math.abs(free), 'near') * Math.sign(free))} a month is left over${changes ? ' with these plans' : ''}`
    if (saved >= 0 && saved <= income) {
      const lead = `On average you saved ${pct(rate)} of your income`
      if (target > 0 && rate + 0.005 < target) {
        const need = income * target - saved
        if (free >= need) items.push({ tone: 'good', text: `${lead}; ${money(need)} more a month reaches ${pct(target)}, and ${left}.` })
        else if (free >= small) {
          items.push({ tone: 'neutral', text: `${lead}; ${left}, which would make it ${pct((saved + free) / income)}. ${pct(target)} needs ${money(need)}.` })
        } else items.push({ tone: 'bad', text: `${lead}. Reaching ${pct(target)} means spending ${money(need - free)} less a month.` })
      } else if (free >= small) {
        const above = target > 0 ? `, above your ${pct(target)} target` : ''
        items.push({ tone: 'good', text: `${lead}${above}, and ${left}. Giving it to ${homeName} would make it ${pct((saved + free) / income)}.` })
      } else if (free <= -small) {
        items.push({ tone: 'bad', text: `Plans that fit need ${money(-free)} a month more than comes in, so spending has to come down.` })
      }
    }
  }

  // -- money that came in and still has no job (a figure that is true now, so only for the current month)
  if (month === current && items.length < 4) {
    const rta = monthView(ix, current, current).readyToAssign
    if (rta >= Math.max(small * 5, 100)) {
      items.push({ tone: 'neutral', text: `${money(rta)} is still in Ready to assign. If you won’t need it this month, give it to ${homeName}.` })
    }
  }
  return { months, items, free }
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

/** Categories saving toward a goal or keeping a buffer, as of `month`: how far along, and when they get there. */
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
    if (!t || cat.archived || !setAside(cat) || t.amount <= 0) continue
    const ms = recent.filter((m) => m !== current || ix.asg.get(m)?.has(cat.id))
    const pace = Math.round(mean(ms.map((m) => (ix.asg.get(m)?.get(cat.id) ?? 0) + (ix.act.get(m)?.get(cat.id) ?? 0))))
    const saved = Math.max(0, view.byId.get(cat.id)?.available ?? 0)
    const missing = t.amount - saved
    const by = t.kind === 'goal' ? t.by : undefined
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

/** "Aug–Oct" for a run of months. */
export function rangeName(months: string[]): string {
  if (!months.length) return ''
  const a = months[0]
  const b = months[months.length - 1]
  const year = a.slice(0, 4) !== b.slice(0, 4)
  const name = (m: string) => monthName(m, { short: true, year })
  return a === b ? name(a) : `${name(a)}–${name(b)}`
}
