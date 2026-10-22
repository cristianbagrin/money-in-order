// Where the money is: each account's balance, the total, and wealth over time.
//
// A balance starts from the newest count that holds the account and adds what moved through it since:
// - cash accounts, when accounts are tracked: spending and income logged to it, and moves in and out;
// - investment accounts, always: moves into it and spending from a savings category linked to it
//   (money put in), on top of the value last typed in.
// Untracked cash accounts keep the balance last counted. The plan's own total is expectedTotal().

import { expectedTotal, type Index } from './budget'
import { daysInMonth } from './dates'
import { convert, type Rates } from './money'
import { live, type Account, type Count, type Day, type ID, type Month, type Txn } from './types'

export interface Balance {
  acct: Account
  /** in the account's own currency */
  bal: number
  /** the same in the base currency, at today's rates */
  base: number
  /** the day the balance was last typed in (null: never) */
  asOf: Day | null
  /** what was typed in that day, in the account's currency (null: never) */
  typedBal: number | null
  /** follows logged transactions, rather than only the last count */
  tracked: boolean
}

/** Counts, newest first. */
export function countsDesc(ix: Index): Count[] {
  return live(ix.db.counts).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.u - a.u))
}

/** A transaction that happened after a count: a later day, or the same day but written after it. */
export function afterCount(t: Txn, c: Count): boolean {
  return t.date > c.date || (t.date === c.date && t.u > c.u)
}

export function accountsInOrder(ix: Index): Account[] {
  return live(ix.db.accounts).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/** Cash accounts are the money the plan is about; investments are kept apart. */
export function cashAccounts(ix: Index): Account[] {
  return accountsInOrder(ix).filter((a) => !a.invest)
}

export function investAccounts(ix: Index): Account[] {
  return accountsInOrder(ix).filter((a) => a.invest)
}

/** Categories whose spending moves money into an investment account: account id -> category ids. */
function linkedCats(ix: Index): Map<ID, Set<ID>> {
  const out = new Map<ID, Set<ID>>()
  for (const c of ix.cats) {
    if (!c.acct) continue
    let s = out.get(c.acct)
    if (!s) out.set(c.acct, (s = new Set()))
    s.add(c.id)
  }
  return out
}

/**
 * What a transaction did to an account, in that account's currency (0 when it didn't touch it).
 * `cash` counts spending and income logged to the account (tracked accounts only).
 */
export function flowInto(t: Txn, a: Account, opts: { cash: boolean; linked?: Set<ID> }, rates: Rates, base: string): number {
  const inCur = (amt: number, cur: string) => (cur === a.cur ? amt : convert(amt, cur, a.cur, rates, base))
  if (t.kind === 'move') {
    let v = 0
    if (t.acct === a.id) v += inCur(t.amt, t.cur)
    if (t.to === a.id) v += t.toAmt ?? inCur(-t.amt, t.cur)
    return v
  }
  if (opts.linked?.has(t.cat) && !t.kind) return inCur(-t.amt, t.cur)
  // (a correction that names the account, like moving an investment out of the plan, is not money in or out of it)
  if (opts.cash && t.acct === a.id && !t.kind) return inCur(t.amt, t.cur)
  return 0
}

/** The newest count holding the account, and the newest where it was typed in (not carried over). */
function anchors(counts: Count[], id: ID): { anchor?: Count; typed?: Count } {
  let anchor: Count | undefined
  for (const c of counts) {
    if (c.bal[id] === undefined) continue
    anchor ??= c
    if (!c.carried?.includes(id)) return { anchor, typed: c }
  }
  return { anchor }
}

/** Every account's balance right now, in display order. */
export function balances(ix: Index): Balance[] {
  const s = ix.settings
  const counts = countsDesc(ix)
  const links = linkedCats(ix)
  return accountsInOrder(ix).map((a) => {
    const { anchor, typed } = anchors(counts, a.id)
    const tracked = !a.invest && !!s.trackAccounts
    const from = anchor ? anchor.bal[a.id] : 0
    const fromCur = anchor?.curs?.[a.id] ?? a.cur
    let bal = fromCur === a.cur ? from : convert(from, fromCur, a.cur, s.rates, s.base)
    if (tracked || a.invest) {
      const opts = { cash: tracked, linked: links.get(a.id) }
      for (const t of ix.txns) {
        if (anchor && t.date < anchor.date) break // newest first
        if (anchor && !afterCount(t, anchor)) continue
        bal += flowInto(t, a, opts, s.rates, s.base)
      }
    }
    bal = Math.round(bal)
    // (a count made before the account changed currency states it in the currency it had then)
    let typedBal: number | null = null
    if (typed) {
      const was = typed.curs?.[a.id] ?? a.cur
      typedBal = was === a.cur ? typed.bal[a.id] : Math.round(convert(typed.bal[a.id], was, a.cur, s.rates, s.base))
    }
    return { acct: a, bal, base: convert(bal, a.cur, s.base, s.rates, s.base), asOf: typed?.date ?? null, typedBal, tracked }
  })
}

/** All the money the plan works with (cash), as the plan sees it. */
export function totalMoney(ix: Index): number {
  return expectedTotal(ix)
}

/** Cash plus investments, in the base currency. */
export function netWorth(ix: Index): number {
  return totalMoney(ix) + balances(ix).reduce((s, b) => s + (b.acct.invest ? b.base : 0), 0)
}

/**
 * Investments whose money is still inside the plan's total: the newest cash count holding the account
 * counted it with the cash (its total adds up with it), and nothing was booked since to take it out.
 * That happens when an account was counted as cash and only later marked as an investment.
 * `base` is what the plan holds, in the base currency at that count's rates.
 */
export function investmentsInPlan(ix: Index): { acct: Account; base: number }[] {
  const s = ix.settings
  const counts = countsDesc(ix)
  const accounts = accountsInOrder(ix)
  const cash = accounts.filter((a) => !a.invest)
  const invests = accounts.filter((a) => a.invest)
  const out: { acct: Account; base: number }[] = []
  for (const a of invests) {
    // the newest count in which a cash account was actually typed (an investments-only count says nothing about the plan)
    const count = counts.find((c) => c.bal[a.id] !== undefined && cash.some((x) => c.bal[x.id] !== undefined && !c.carried?.includes(x.id)))
    if (!count) continue
    const out1 = ix.txns.find((t) => t.kind === 'adj' && t.acct === a.id && afterCount(t, count)) // newest first
    if (out1 && out1.base < 0) continue
    const inBase = (x: Account) => convert(count.bal[x.id], count.curs?.[x.id] ?? x.cur, s.base, count.rates, s.base)
    const mine = inBase(a)
    const held = cash.reduce((sum, x) => sum + (count.bal[x.id] === undefined ? 0 : inBase(x)), 0)
    const others = invests.filter((x) => x.id !== a.id && count.bal[x.id] !== undefined).slice(0, 8)
    const tol = 2 * (cash.length + others.length + 1)
    if (mine <= tol) continue
    // does the counted total add up with this account in it (and any of the other investments)?
    let included = false
    for (let mask = 0; mask < 1 << others.length && !included; mask++) {
      const sum = held + mine + others.reduce((n, x, i) => n + (mask & (1 << i) ? inBase(x) : 0), 0)
      included = Math.abs(count.total - sum) <= tol
    }
    if (included) out.push({ acct: a, base: Math.round(mine) })
  }
  return out
}

export interface WealthPoint {
  month: Month
  /** the plan's money at the end of the month (or today) */
  cash: number
  /** investments' value at the end of the month, as far as known */
  invest: number
  total: number
  /** money put into investments during the month */
  added: number
}

/**
 * Wealth at the end of each month (today for the current one), oldest first. Investment values come from
 * the counts (at that count's rates) plus what was put in since; with no value known yet they count as 0.
 */
export function wealthSeries(ix: Index, months: Month[], today: Day): WealthPoint[] {
  const s = ix.settings
  const invests = investAccounts(ix)
  const counts = countsDesc(ix)
  const links = linkedCats(ix)
  const asc = [...ix.txns].reverse()
  return months.map((m) => {
    const lastDay = `${m}-${String(daysInMonth(m)).padStart(2, '0')}`
    const end = lastDay < today ? lastDay : today
    let cash = 0
    let added = 0
    for (const t of asc) {
      if (t.date > end) break
      cash += t.base
    }
    let invest = 0
    for (const a of invests) {
      const anchor = counts.find((c) => c.date <= end && c.bal[a.id] !== undefined)
      const rates = anchor?.rates ?? s.rates
      let v = anchor ? convert(anchor.bal[a.id], anchor.curs?.[a.id] ?? a.cur, s.base, rates, s.base) : 0
      const linked = links.get(a.id)
      for (const t of asc) {
        if (t.date > end) break
        // put in during this month
        const inBase = t.kind === 'move' ? convert(flowInto(t, a, { cash: false }, s.rates, s.base), a.cur, s.base, s.rates, s.base) : linked?.has(t.cat) && !t.kind ? -t.base : 0
        if (!inBase) continue
        if (t.date.slice(0, 7) === m) added += inBase
        if (!anchor || afterCount(t, anchor)) v += inBase
      }
      invest += Math.round(v)
    }
    return { month: m, cash, invest, total: cash + invest, added }
  })
}
