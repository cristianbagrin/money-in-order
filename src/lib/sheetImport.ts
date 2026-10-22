// One-time import of months kept in a spreadsheet before this app (temporary: remove once used).
//
// The file holds, per month, the plan (what each category got), the transactions and the balance the
// month started with. The sheet started every month fresh, so each imported month's plan is set so its
// categories start where the sheet's did. Money on hand today stays exactly what it is: the count this
// budget started from becomes a correction against the imported history.

import { monthView } from './budget'
import { addMonths, monthOf } from './dates'
import { addCategory, commit, getDB, getIndex, setAssigned, settings, toBase, uid } from './store'
import { RTA, live, type ID, type Month, type Txn } from './types'

export interface SheetTxn {
  date: string
  /** category name, or "Income" */
  cat: string
  amt: number
  cur: string
  /** in the file's currency */
  base: number
  note?: string
}

export interface SheetMonth {
  month: Month
  /** money on hand when the month began, in the file's currency */
  start: number
  startNote?: string
  /** category name -> planned amount */
  plan: Record<string, number>
  txns: SheetTxn[]
}

export interface SheetFile {
  kind: 'money-in-order/sheet-import'
  version: 1
  currency: string
  months: SheetMonth[]
}

export function readSheetFile(text: string): SheetFile | null {
  try {
    const f = JSON.parse(text) as SheetFile
    return f.kind === 'money-in-order/sheet-import' && Array.isArray(f.months) ? f : null
  } catch {
    return null
  }
}

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Entries already logged here in a month (not counts or opening balances). */
export function loggedIn(month: Month): Txn[] {
  return live(getDB().txns).filter((t) => monthOf(t.date) === month && !t.kind)
}

/** Import `months` from the file; `replace` lists the months whose entries logged here are replaced. Run inside undoable(). */
export function importSheet(file: SheetFile, months: Month[], replace: Month[]): number {
  const s = settings()
  const inBase = (v: number) => (file.currency === s.base ? v : toBase(v, file.currency))
  const chosen = file.months.filter((m) => months.includes(m.month)).sort((a, b) => (a.month < b.month ? -1 : 1))
  if (!chosen.length) return 0

  // Categories by name; any the sheet has and this budget doesn't are added to the last group.
  const cats = new Map<string, ID>()
  for (const c of live(getDB().cats)) if (!cats.has(key(c.name)) || !c.archived) cats.set(key(c.name), c.id)
  const catOf = (name: string): ID => {
    if (key(name) === 'income') return RTA
    let id = cats.get(key(name))
    if (!id) {
      const groups = live(getDB().groups).sort((a, b) => a.order - b.order)
      id = addCategory(groups[groups.length - 1].id, name).id
      cats.set(key(name), id)
    }
    return id
  }

  const money = () => live(getDB().txns).reduce((sum, t) => sum + t.base, 0)
  const before = money()
  const firstDay = `${chosen[0].month}-01`
  const opening = live(getDB().txns)
    .filter((t) => t.kind === 'start')
    .sort((a, b) => (a.date < b.date ? -1 : 1))[0]
  let added = 0

  for (const m of chosen) {
    if (replace.includes(m.month)) commit({ txns: loggedIn(m.month).map((t) => ({ ...t, d: 1 as const })) })
    // The month's opening balance: the first one starts the budget, later ones settle what the sheet couldn't explain.
    const day = `${m.month}-01`
    const held = live(getDB().txns).reduce((sum, t) => (t.date < day ? sum + t.base : sum), 0)
    const first = m === chosen[0] && !(opening && opening.date < day)
    const gap = inBase(m.start) - (first ? 0 : held)
    const txns: Txn[] = m.txns.map((t) => ({
      id: uid(),
      u: 0,
      date: t.date,
      cat: catOf(t.cat),
      amt: t.amt,
      cur: t.cur,
      base: inBase(t.base),
      ...(t.note ? { note: t.note } : {}),
    }))
    if (gap) {
      const note = first ? 'Starting balance' : 'Count correction'
      txns.push({ id: uid(), u: 0, date: day, cat: RTA, amt: gap, cur: s.base, base: gap, kind: first ? 'start' : 'adj', note })
    }
    commit({ txns })
    added += m.txns.length
    settle(m.month, Object.fromEntries(Object.entries(m.plan).map(([name, v]) => [catOf(name), inBase(v)])))
  }

  // The month after the import starts fresh too, when it already has a plan here.
  const next = addMonths(chosen[chosen.length - 1].month, 1)
  if (!months.includes(next) && live(getDB().assigns).some((a) => a.m === next && a.amt)) {
    const plan: Record<ID, number> = {}
    for (const a of live(getDB().assigns)) if (a.m === next) plan[a.cat] = a.amt
    settle(next, plan, [...new Set(chosen.flatMap((m) => Object.keys(m.plan).map(catOf)))])
  }

  // Keep today's money as it is: the count this budget started from now corrects the imported history.
  const drift = money() - before
  if (opening && drift) {
    const was = getDB().txns[opening.id]
    if (was && !was.d) {
      const amt = was.base - drift
      const fix: Txn = amt
        ? { ...was, amt, base: amt, cur: s.base, kind: was.date >= firstDay ? 'adj' : 'start', note: was.date >= firstDay ? 'Count correction' : was.note }
        : { ...was, d: 1 }
      commit({ txns: [fix] })
    }
  }
  return added
}

/** Give a month's categories their planned amount on top of a fresh start: last month's leftovers and overspending are settled. */
function settle(month: Month, plan: Record<ID, number>, also: ID[] = []) {
  const prev = monthView(getIndex(), addMonths(month, -1), month)
  for (const id of new Set([...Object.keys(plan), ...also])) {
    const carry = prev.byId.get(id)?.available ?? 0
    const want = plan[id] ?? 0
    if (carry || want || plan[id] !== undefined) setAssigned(month, id, want - carry)
  }
}
