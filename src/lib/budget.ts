import { addMonths, dayOfMonth, daysInMonth, monthDiff, monthOf } from './dates'
import { live, RTA, type Category, type DB, type Group, type ID, type Month, type Settings, type Txn } from './types'

export const DEFAULT_SETTINGS: Omit<Settings, 'id' | 'u'> = {
  base: 'TWD',
  rates: {},
  ratesAt: 0,
  savingsTarget: 0.2,
  extraCurrencies: [],
}

export function settingsOf(db: DB): Settings {
  const s = db.meta.settings ?? { id: 'settings', u: 0, ...DEFAULT_SETTINGS }
  // Rates have their own record, so a background refresh never rewrites the user's settings.
  // Budgets saved before that (or by an older app version) still carry them in the settings record.
  const t = db.meta.rates
  return t && !t.d && t.table?.base === s.base ? { ...s, rates: t.table.rates, ratesAt: t.table.at } : s
}

/** Precomputed sums over the whole database. Rebuilt whenever the database changes. */
export interface Index {
  db: DB
  settings: Settings
  groups: Group[]
  /** every non-deleted category in display order, archived included */
  cats: Category[]
  catById: Map<ID, Category>
  /** month -> category -> signed sum of base amounts (negative = spending) */
  act: Map<Month, Map<ID, number>>
  /** month -> Σ of everything that went to Ready to Assign (income, opening balances, corrections) */
  inflow: Map<Month, number>
  /** month -> real income only */
  income: Map<Month, number>
  /** month -> category -> assigned */
  asg: Map<Month, Map<ID, number>>
  /** months that hold any data, ascending */
  months: Month[]
  /** all transactions, newest first */
  txns: Txn[]
}

function bump(map: Map<Month, Map<ID, number>>, m: Month, id: ID, v: number) {
  let inner = map.get(m)
  if (!inner) map.set(m, (inner = new Map()))
  inner.set(id, (inner.get(id) ?? 0) + v)
}

export function buildIndex(db: DB): Index {
  const groups = live(db.groups).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  const gOrder = new Map(groups.map((g, i) => [g.id, i]))
  // An older app version's 'refill' target is a top-up.
  const cats = live(db.cats)
    .map((c) => (c.target?.kind === 'refill' ? { ...c, target: { kind: 'topup' as const, amount: c.target.amount } } : c))
    .sort(
    (a, b) => (gOrder.get(a.group) ?? 99) - (gOrder.get(b.group) ?? 99) || a.order - b.order || a.name.localeCompare(b.name),
  )
  const catById = new Map(cats.map((c) => [c.id, c]))
  const act = new Map<Month, Map<ID, number>>()
  const asg = new Map<Month, Map<ID, number>>()
  const inflow = new Map<Month, number>()
  const income = new Map<Month, number>()
  const monthSet = new Set<Month>()
  const txns = live(db.txns)
  for (const t of txns) {
    const m = monthOf(t.date)
    monthSet.add(m)
    if (t.cat === RTA) {
      inflow.set(m, (inflow.get(m) ?? 0) + t.base)
      if (!t.kind) income.set(m, (income.get(m) ?? 0) + t.base)
    } else {
      bump(act, m, t.cat, t.base)
    }
  }
  for (const a of live(db.assigns)) {
    if (!a.amt) continue
    monthSet.add(a.m)
    bump(asg, a.m, a.cat, a.amt)
  }
  txns.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.u - a.u))
  return {
    db,
    settings: settingsOf(db),
    groups,
    cats,
    catById,
    act,
    inflow,
    income,
    asg,
    months: [...monthSet].sort(),
    txns,
  }
}

export interface CatMonth {
  cat: Category
  /** available at the end of the previous month */
  carry: number
  assigned: number
  /** signed: negative = spent */
  activity: number
  available: number
  /** how much more to assign this month to meet the target */
  need: number
  /** what the target asks of this month in total (for display) */
  goal: number
}

export interface GroupMonth {
  group: Group
  cats: CatMonth[]
  assigned: number
  activity: number
  available: number
}

export interface MonthView {
  month: Month
  cats: CatMonth[]
  byId: Map<ID, CatMonth>
  groups: GroupMonth[]
  readyToAssign: number
  income: number
  inflow: number
  /** spending outside savings categories, as a positive number */
  spent: number
  /** money given to savings categories this month (net) */
  saved: number
  savingsRate: number | null
  assigned: number
  available: number
  need: number
  overspent: CatMonth[]
}

function sumMap(m: Map<ID, number> | undefined): number {
  let s = 0
  if (m) for (const v of m.values()) s += v
  return s
}

/** Needed this month to satisfy a category's target. */
export function targetNeed(cat: Category, carry: number, assigned: number, month: Month): { need: number; goal: number } {
  const t = cat.target
  const debt = Math.max(0, -carry)
  if (!t) return { need: debt > 0 ? Math.max(0, debt - assigned) : 0, goal: debt }
  // Monthly: the month has the amount to spend, so what came over counts and overspending is made up.
  if (t.kind === 'monthly') {
    const goal = Math.max(0, t.amount - carry)
    return { need: Math.max(0, goal - assigned), goal }
  }
  // Top up: the same amount every month, whatever came over; an overspent month heals as the next ones add to it.
  if (t.kind === 'topup' || t.kind === 'refill') return { need: Math.max(0, t.amount - assigned), goal: t.amount }
  // goal: spread what's missing over the months left
  const missing = t.amount - carry
  if (missing <= 0) return { need: 0, goal: 0 }
  const monthsLeft = t.by ? Math.max(1, monthDiff(month, t.by) + 1) : 1
  const goal = Math.ceil(missing / monthsLeft / 100) * 100
  return { need: Math.max(0, Math.min(missing, goal) - assigned), goal: Math.min(missing, goal) }
}

/** Views already worked out for an index: the screens, badges and sheets showing one change all ask for the same month. */
const views = new WeakMap<Index, Map<string, MonthView>>()

/**
 * The state of the budget in a month (shared: don't change what it returns).
 * `current` is the real current month: for it and later months, money already assigned to
 * future months is not ready to assign again.
 */
export function monthView(ix: Index, month: Month, current: Month): MonthView {
  let known = views.get(ix)
  if (!known) views.set(ix, (known = new Map()))
  const key = `${month}|${current}`
  let v = known.get(key)
  if (!v) known.set(key, (v = computeView(ix, month, current)))
  return v
}

function computeView(ix: Index, month: Month, current: Month): MonthView {
  const carry = new Map<ID, number>()
  // Ready to assign is one number that is true now: past months show today's figure,
  // and money given to any month (past or future) is no longer available to give again.
  const upTo = month > current ? month : current
  let inflowThrough = 0
  let assignedAll = 0
  for (const m of ix.months) {
    if (m < month) {
      for (const [id, v] of ix.asg.get(m) ?? []) carry.set(id, (carry.get(id) ?? 0) + v)
      for (const [id, v] of ix.act.get(m) ?? []) carry.set(id, (carry.get(id) ?? 0) + v)
    }
    if (m <= upTo) inflowThrough += ix.inflow.get(m) ?? 0
    assignedAll += sumMap(ix.asg.get(m))
  }
  const asg = ix.asg.get(month)
  const act = ix.act.get(month)
  const cats: CatMonth[] = []
  const byId = new Map<ID, CatMonth>()
  for (const cat of ix.cats) {
    const c = carry.get(cat.id) ?? 0
    const assigned = asg?.get(cat.id) ?? 0
    const activity = act?.get(cat.id) ?? 0
    const available = c + assigned + activity
    if (cat.archived && available === 0 && !activity) continue
    const { need, goal } = cat.archived ? { need: 0, goal: 0 } : targetNeed(cat, c, assigned, month)
    const cm: CatMonth = { cat, carry: c, assigned, activity, available, need, goal }
    cats.push(cm)
    byId.set(cat.id, cm)
  }
  // A category whose group is gone shows under the first group rather than vanish with its money.
  const known = new Set(ix.groups.map((g) => g.id))
  const groups: GroupMonth[] = ix.groups.map((group, i) => {
    const gc = cats.filter((c) => c.cat.group === group.id || (i === 0 && !known.has(c.cat.group)))
    return {
      group,
      cats: gc,
      assigned: gc.reduce((s, c) => s + c.assigned, 0),
      activity: gc.reduce((s, c) => s + c.activity, 0),
      available: gc.reduce((s, c) => s + c.available, 0),
    }
  })
  const income = ix.income.get(month) ?? 0
  let spent = 0
  let saved = 0
  for (const c of cats) {
    if (c.cat.saving) saved += c.assigned
    else spent -= c.activity
  }
  return {
    month,
    cats,
    byId,
    groups,
    readyToAssign: inflowThrough - assignedAll,
    income,
    inflow: ix.inflow.get(month) ?? 0,
    spent,
    saved,
    savingsRate: income > 0 ? saved / income : null,
    assigned: cats.reduce((s, c) => s + c.assigned, 0),
    available: cats.reduce((s, c) => s + c.available, 0),
    need: cats.reduce((s, c) => s + c.need, 0),
    overspent: cats.filter((c) => c.available < 0),
  }
}

/** Money given to months after `current`: what makes Ready to assign negative when a coming month is planned ahead of its income. */
export function assignedAhead(ix: Index, current: Month): number {
  let s = 0
  for (const [m, a] of ix.asg) if (m > current) for (const v of a.values()) s += v
  return s
}

/** Total money the budget believes exists right now (= Ready to Assign + everything available). */
export function expectedTotal(ix: Index): number {
  let s = 0
  for (const t of ix.txns) s += t.base
  return s
}

export interface Daily {
  cats: Category[]
  /** pooled available in daily categories right now */
  available: number
  /** today's share, decided at the start of the day */
  allowance: number
  /** allowance minus what was spent today (can go negative) */
  leftToday: number
  spentToday: number
  /** what tomorrow's share becomes if nothing else is spent today */
  tomorrow: number | null
  daysLeft: number
  /** total money the daily categories had for the whole month */
  monthBudget: number
  /** spent in daily categories this month (positive) */
  monthSpent: number
}

/** "Living/day": what's left in daily categories, spread over the days left in the month. */
export function daily(ix: Index, view: MonthView, today: string): Daily | null {
  const cats = view.cats.filter((c) => c.cat.daily && !c.cat.archived)
  if (!cats.length) return null
  const ids = new Set(cats.map((c) => c.cat.id))
  let todayAct = 0
  for (const t of ix.txns) {
    if (t.date < today) break
    if (t.date === today && ids.has(t.cat)) todayAct += t.base
  }
  const available = cats.reduce((s, c) => s + c.available, 0)
  const month = monthOf(today)
  const daysLeft = daysInMonth(month) - dayOfMonth(today) + 1
  const startOfDay = available - todayAct
  const unit = 100
  const allowance = Math.floor(Math.max(0, startOfDay) / daysLeft / unit) * unit
  const tomorrow = daysLeft > 1 ? Math.floor(Math.max(0, available) / (daysLeft - 1) / unit) * unit : null
  return {
    cats: cats.map((c) => c.cat),
    available,
    allowance,
    leftToday: allowance + todayAct,
    spentToday: -todayAct,
    tomorrow,
    daysLeft,
    monthBudget: cats.reduce((s, c) => s + c.carry + c.assigned, 0),
    monthSpent: -cats.reduce((s, c) => s + c.activity, 0),
  }
}

/** Average monthly spending in a category over the `n` months before `month` that had any activity. */
export function averageSpent(ix: Index, cat: ID, month: Month, n = 3): number {
  let total = 0
  let count = 0
  for (let i = 1; i <= n; i++) {
    const m = addMonths(month, -i)
    const a = ix.act.get(m)?.get(cat)
    if (a !== undefined) {
      total += -a
      count++
    }
  }
  return count ? Math.round(total / count) : 0
}

export function assignedInMonth(ix: Index, cat: ID, month: Month): number {
  return ix.asg.get(month)?.get(cat) ?? 0
}
