import { beforeEach, describe, expect, it } from 'vitest'
import { balances, wealthSeries } from '../src/lib/accounts'
import { assignedAhead, buildIndex, daily, expectedTotal, monthView } from '../src/lib/budget'
import { addDays, addMonths, monthOf } from '../src/lib/dates'
import { claudeSummary, transactionsCSV } from '../src/lib/export'
import { hasNews, merge } from '../src/lib/merge'
import { fillPlan, forecast, suggestions } from '../src/lib/plan'
import * as S from '../src/lib/store'
import { COLLECTIONS, emptyDB, live, RTA, type DB, type ID, type Rec } from '../src/lib/types'
import { bigDB, rng } from './fixtures/big'

// Random sequences of what the screens do, each step checked against the rules the money must follow,
// and every step undone and redone to see that undo puts back exactly what was there.

const TODAY = '2026-10-22'
const CUR = monthOf(TODAY)
const MONTHS = [addMonths(CUR, -3), addMonths(CUR, -2), addMonths(CUR, -1), CUR, addMonths(CUR, 1), addMonths(CUR, 2)]

/** The live records, without the bookkeeping that changes with every write. */
function content(db: DB): Record<string, Record<ID, Record<string, unknown>>> {
  const out: Record<string, Record<ID, Record<string, unknown>>> = {}
  for (const name of COLLECTIONS) {
    const coll: Record<ID, Record<string, unknown>> = {}
    for (const r of Object.values(db[name]) as Rec[]) {
      if (r.d) continue
      const { u: _u, f: _f, d: _d, ...rest } = r
      coll[r.id] = rest
    }
    out[name] = coll
  }
  return out
}

/** The rules every budget must keep, whatever happened to it. */
function check(db: DB, label: string) {
  const ix = buildIndex(db)
  const views = MONTHS.map((m) => monthView(ix, m, CUR))
  for (const v of views) {
    for (const n of [v.readyToAssign, v.income, v.inflow, v.spent, v.saved, v.assigned, v.available, v.need]) {
      expect(Number.isInteger(n), `${label}: ${v.month} has a figure that isn't whole minor units: ${n}`).toBe(true)
    }
    for (const c of v.cats) {
      for (const n of [c.carry, c.assigned, c.activity, c.available, c.need, c.goal]) {
        expect(Number.isInteger(n), `${label}: ${c.cat.name} in ${v.month}: ${n}`).toBe(true)
      }
      expect(c.available, `${label}: ${c.cat.name} available`).toBe(c.carry + c.assigned + c.activity)
    }
    // Every category with money or spending shows up somewhere in the plan.
    const shown = v.groups.reduce((s, g) => s + g.cats.length, 0)
    expect(shown, `${label}: categories lost from the groups in ${v.month}`).toBe(v.cats.length)
  }
  // One pool of money: what came in and went out so far is exactly what's ready to assign, what the
  // categories hold, and what is already given to coming months.
  const now = views[MONTHS.indexOf(CUR)]
  let txnTotal = 0
  for (const t of live(db.txns)) if (monthOf(t.date) <= CUR) txnTotal += t.base
  const held = now.cats.reduce((s, c) => s + c.available, 0)
  expect(txnTotal, `${label}: the money doesn't add up`).toBe(now.readyToAssign + held + assignedAhead(ix, CUR))
  expect(expectedTotal(ix)).toBe(live(db.txns).reduce((s, t) => s + t.base, 0))
  // Nothing dangles: every transaction and every amount assigned belongs to a category the index knows.
  for (const t of live(db.txns)) if (t.cat !== RTA) expect(ix.catById.has(t.cat), `${label}: txn ${t.id} in a missing category`).toBe(true)
  for (const a of live(db.assigns)) if (a.amt) expect(ix.catById.has(a.cat), `${label}: money in a missing category`).toBe(true)
  // Merging a budget with itself changes nothing.
  expect(hasNews(db, db)).toBe(false)
  expect(merge(db, db)).toEqual(db)
  // The heavier screens run without throwing and without NaN.
  const fc = forecast(ix, CUR)
  for (const m of fc.months) expect(Number.isFinite(m.left) && Number.isFinite(m.need), `${label}: forecast`).toBe(true)
  for (const s of suggestions(ix, CUR, CUR)) expect(Number.isFinite(s.want), `${label}: suggestion`).toBe(true)
  const d = daily(ix, now, TODAY)
  if (d) expect(Number.isFinite(d.leftToday) && Number.isFinite(d.allowance), `${label}: daily`).toBe(true)
  for (const b of balances(ix)) expect(Number.isFinite(b.bal) && Number.isFinite(b.base), `${label}: balance`).toBe(true)
  for (const p of wealthSeries(ix, MONTHS, TODAY)) expect(Number.isFinite(p.total), `${label}: wealth`).toBe(true)
}

/** Snapshots a restore can go back to. */
const backups: DB[] = []

function pick<T>(r: () => number, xs: T[]): T | undefined {
  return xs.length ? xs[Math.floor(r() * xs.length)] : undefined
}

/** One thing a person might do, picked at random; returns a label, or null when it didn't apply. */
function act(r: () => number): string | null {
  const db = S.getDB()
  const ix = S.getIndex()
  const cats = ix.cats.filter((c) => !c.archived)
  const anyCat = pick(r, ix.cats)
  const cat = pick(r, cats)
  const txn = pick(r, ix.txns)
  const groups = ix.groups
  const accounts = live(db.accounts)
  const date = addDays(TODAY, -Math.floor(r() * 100))
  const month = pick(r, MONTHS)!
  const amount = () => Math.round(r() * 5000) * 100 + (r() < 0.2 ? Math.round(r() * 99) : 0)
  const currency = () => pick(r, ['TWD', 'TWD', 'TWD', 'EUR', 'JPY', 'USD'])!
  const n = Math.floor(r() * 34)
  switch (n) {
    case 0:
    case 1:
    case 2:
      if (!cat) return null
      S.undoable('spend', () => S.addTxn({ date, cat: cat.id, amt: -amount(), cur: currency(), note: r() < 0.3 ? 'lunch' : undefined, acct: pick(r, accounts)?.id }))
      return 'spend'
    case 3:
      S.undoable('income', () => S.addTxn({ date, cat: RTA, amt: amount() * 10, cur: currency(), src: r() < 0.5 ? 's1' : undefined }))
      return 'income'
    case 4:
      if (!txn || txn.kind) return null
      S.undoable('edit amount', () => S.updateTxn(txn.id, { amt: Math.sign(txn.amt || -1) * amount() }))
      return 'edit amount'
    case 5:
      if (!txn || txn.kind || !cat || txn.cat === RTA) return null
      S.undoable('edit category', () => S.updateTxn(txn.id, { cat: cat.id, note: r() < 0.5 ? 'moved' : '' }))
      return 'edit category'
    case 6:
      if (!txn || txn.kind) return null
      S.undoable('edit currency/date', () => S.updateTxn(txn.id, r() < 0.5 ? { cur: currency() } : { date }))
      return 'edit currency/date'
    case 7:
      if (!txn) return null
      S.undoable('delete', () => S.deleteTxns(ix.txns.filter(() => r() < 0.02).map((t) => t.id).concat(txn.id)))
      return 'delete'
    case 8:
    case 9:
    case 10:
      if (!cat) return null
      S.undoable('assign', () => S.setAssigned(month, cat.id, r() < 0.1 ? 0 : amount()))
      return 'assign'
    case 11: {
      const to = pick(r, cats)
      if (!cat || !to) return null
      S.undoable('cover', () => S.moveMoney(month, r() < 0.3 ? RTA : cat.id, to.id, amount()))
      return 'cover'
    }
    case 12: {
      const g = pick(r, groups)
      if (!g) return null
      S.undoable('add category', () => S.addCategory(g.id, `Cat ${Math.floor(r() * 1000)}`, r() < 0.3 ? { daily: true } : r() < 0.3 ? { saving: true } : {}))
      return 'add category'
    }
    case 13: {
      if (!cat) return null
      const kind = Math.floor(r() * 4)
      const target =
        kind === 0 ? undefined : kind === 1 ? { kind: 'monthly' as const, amount: amount() } : kind === 2 ? { kind: 'topup' as const, amount: amount() } : { kind: 'goal' as const, amount: amount() * 20, by: r() < 0.5 ? addMonths(CUR, Math.floor(r() * 12) - 2) : undefined }
      S.undoable('target', () => S.saveCategory({ ...cat, name: r() < 0.3 ? cat.name + '!' : cat.name, target }))
      return 'target'
    }
    case 14:
      if (!cat) return null
      S.undoable('archive', () => S.archiveCategory(cat.id, CUR, CUR))
      return 'archive'
    case 15: {
      const archived = ix.cats.filter((c) => c.archived)
      const c = pick(r, archived)
      if (!c) return null
      S.undoable('unarchive', () => S.unarchiveCategory(c.id))
      return 'unarchive'
    }
    case 16: {
      // as the category sheet does it: unused goes, money only goes with its money, transactions go somewhere
      if (!anyCat) return null
      const hasTxns = ix.txns.some((t) => t.cat === anyCat.id)
      const into = pick(r, cats.filter((c) => c.id !== anyCat.id))
      if (!S.categoryHasHistory(anyCat.id)) S.undoable('delete category', () => S.deleteCategory(anyCat.id))
      else if (!hasTxns || r() < 0.3) S.undoable('delete category', () => S.deleteCategory(anyCat.id, { dropTxns: true }))
      else if (into) S.undoable('delete category', () => S.deleteCategory(anyCat.id, { into: into.id }))
      else return null
      return 'delete category'
    }
    case 17: {
      const g = pick(r, groups)
      if (!cat || !g) return null
      S.undoable('drag category', () => S.placeCategory(cat.id, g.id, Math.floor(r() * 5)))
      return 'drag category'
    }
    case 18: {
      if (r() < 0.5) {
        S.undoable('add group', () => S.addGroup(`Group ${Math.floor(r() * 100)}`))
        return 'add group'
      }
      // only an empty group can be deleted from the plan
      const empty = groups.filter((g) => !ix.cats.some((c) => c.group === g.id))
      const g = pick(r, empty)
      if (!g) return null
      S.undoable('delete group', () => S.deleteGroup(g.id))
      return 'delete group'
    }
    case 19: {
      if (accounts.length < 4 || r() < 0.2) {
        S.undoable('add account', () => S.addAccount(`Acct ${accounts.length}`, currency(), { invest: r() < 0.25 }))
        return 'add account'
      }
      const a = pick(r, accounts)!
      S.undoable('investment', () => S.setInvestment(a.id, !a.invest, TODAY))
      return 'investment'
    }
    case 20: {
      if (!accounts.length) return null
      const bal: Record<ID, number> = {}
      for (const a of accounts) if (r() < 0.7) bal[a.id] = amount() * 10
      S.undoable('count', () => S.recordCount({ date: TODAY, bal, rates: S.settings().rates, diffTo: r() < 0.5 || !cat ? RTA : cat.id }))
      return 'count'
    }
    case 21: {
      const [from, to] = [pick(r, accounts), pick(r, accounts)]
      if (!from || !to || from.id === to.id) return null
      S.undoable('move between accounts', () => S.addMove({ date: TODAY, from: from.id, to: to.id, amt: amount() }))
      return 'move between accounts'
    }
    case 22:
      S.undoable('note', () => S.setNote(month, r() < 0.2 ? '' : `Note ${Math.floor(r() * 10)}`))
      return 'note'
    case 23: {
      const next = S.settings().base === 'TWD' ? pick(r, ['EUR', 'USD', 'JPY'])! : 'TWD'
      if (!S.undoable('budget currency', () => S.changeBase(next))) return null
      return 'budget currency'
    }
    case 24:
      S.undoable('settings', () => S.updateSettings({ savingsTarget: Math.round(r() * 50) / 100, trackAccounts: r() < 0.5 ? 1 : undefined }))
      return 'settings'
    case 26: {
      // Fill in, as the plan does it: every suggestion for the month in one step
      const plan = fillPlan(suggestions(ix, month, CUR), r() < 0.5 ? Infinity : amount() * 10)
      if (!plan.length) return null
      S.undoable('fill in', () => {
        for (const p of plan) S.setAssigned(month, p.cat, p.amount)
      })
      return 'fill in'
    }
    case 27: {
      const old = pick(r, backups)
      if (!old) {
        backups.push(structuredClone(db))
        return null
      }
      S.undoable('restore backup', () => S.restoreBackup(structuredClone(old)))
      return 'restore backup'
    }
    case 28: {
      const a = pick(r, accounts.filter((x) => x.invest))
      if (!a) return null
      S.undoable('take out of plan', () => S.takeOutOfPlan(a.id, TODAY))
      return 'take out of plan'
    }
    case 29: {
      const a = pick(r, accounts)
      const g = pick(r, groups)
      if (!a || !g) return null
      S.undoable('reorder', () => (r() < 0.5 ? S.placeAccountOfKind(a.id, Math.floor(r() * 4)) : S.placeGroup(g.id, Math.floor(r() * 4))))
      return 'reorder'
    }
    case 30: {
      const s = S.settings()
      if (!s.extraCurrencies.includes('EUR')) {
        S.undoable('add currency', () => S.updateSettings({ extraCurrencies: [...s.extraCurrencies, 'EUR', 'USD'] }))
        return 'add currency'
      }
      S.undoable('reorder currency', () => S.placeCurrency(pick(r, s.extraCurrencies)!, Math.floor(r() * 3)))
      return 'reorder currency'
    }
    case 31: {
      if (!txn || txn.kind) return null
      const every = pick(r, ['month', 'year', null] as const)!
      S.undoable('repeat', () => S.setRepeat(txn.id, every))
      return 'repeat'
    }
    case 32: {
      // Months go by: repeats set up a while ago log what came due (twice is the same as once).
      const reps = live(db.repeats ?? {})
      if (!reps.length) return null
      S.commit({ repeats: reps.map((x) => ({ ...x, after: addDays(TODAY, -Math.floor(r() * 400)) })) })
      const made = S.logRepeats(TODAY)
      expect(S.logRepeats(TODAY)).toEqual([])
      for (const t of made) expect(t.date <= TODAY && t.u <= Date.now(), 'a repeat logged ahead of time').toBe(true)
      return 'log repeats'
    }
    default:
      if (r() < 0.5 && S.sources().length > 1) {
        const x = pick(r, S.sources())!
        S.undoable('reorder source', () => (r() < 0.5 ? S.placeSource(x.id, 0) : S.renameSource(x.id, x.name + '+')))
        return 'reorder source'
      }
      S.undoable('income source', () => (r() < 0.5 ? S.addSource(`Source ${Math.floor(r() * 9)}`) : S.deleteSource(pick(r, S.sources())?.id ?? '')))
      return 'income source'
  }
}

function start() {
  backups.length = 0
  S.clearUndo()
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: { EUR: 35.2, USD: 32.1, JPY: 0.2131 }, ready: 1, sources: [{ id: 's1', name: 'Job' }] })
  S.seedCategories()
  S.addAccount('Bank', 'TWD')
}

beforeEach(start)

describe('random use, checked at every step', () => {
  // Hunt harder with STRESS_SEEDS=80 STRESS_STEPS=400 npm test
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
  const SEEDS = Number(env.STRESS_SEEDS ?? 6)
  const STEPS = Number(env.STRESS_STEPS ?? 150)
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed)
      const trail: string[] = []
      for (let step = 0; step < STEPS; step++) {
        const before = content(S.getDB())
        const top = S.lastUndo()
        const label = act(r)
        if (!label) continue
        trail.push(label)
        const where = `seed ${seed}, step ${step} (${trail.slice(-4).join(' → ')})`
        const after = content(S.getDB())
        check(S.getDB(), where)
        // (a step that changed nothing leaves no undo step of its own)
        if (S.lastUndo() !== top && r() < 0.5) {
          // Undo puts back exactly what was there; redo brings the change back.
          S.undo()
          expect(content(S.getDB()), `${where}: undo`).toEqual(before)
          check(S.getDB(), `${where}, undone`)
          S.redo()
          expect(content(S.getDB()), `${where}: redo`).toEqual(after)
        }
        if (r() < 0.05) {
          // Several undos in a row walk back through the steps.
          S.undo()
          S.undo()
          S.undo()
          check(S.getDB(), `${where}, three undone`)
        }
      }
    })
  }
})

describe('a budget saved and loaded again', () => {
  it('is the same budget', () => {
    const r = rng(42)
    for (let step = 0; step < 300; step++) act(r)
    const db = S.getDB()
    const views = MONTHS.map((m) => monthView(S.getIndex(), m, CUR))
    S.replaceDB(JSON.parse(JSON.stringify(db)))
    expect(MONTHS.map((m) => monthView(S.getIndex(), m, CUR))).toEqual(views)
  })
})

describe('a big budget', () => {
  it('keeps the rules and stays quick', () => {
    const db = bigDB({ from: '2020-11', months: 72, perDay: 4 })
    check(db, 'six years')
    S.replaceDB(db)
    const ix = S.getIndex()
    const t0 = performance.now()
    claudeSummary(ix, TODAY, { months: 6, transactions: true })
    transactionsCSV(ix)
    forecast(ix, CUR)
    wealthSeries(ix, [...ix.months], TODAY)
    // generous: this is a guard against something going quadratic, not a benchmark
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
