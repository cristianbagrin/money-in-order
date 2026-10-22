import type { Rates } from './money'

export type ID = string
/** "YYYY-MM" */
export type Month = string
/** "YYYY-MM-DD" */
export type Day = string

/** Every stored record carries an update time (ms) and an optional tombstone, so two devices can merge. */
export interface Rec {
  id: ID
  u: number
  d?: 1
  /** when single fields changed, if not all at `u` (see merge.ts) */
  f?: Stamps
}

/** field -> update time. `$` repeats the record's `u` (so an edit by an older app is noticed), `_` is the time of every field not listed. */
export type Stamps = Record<string, number>

/** Pseudo-category for income and anything else that feeds "Ready to Assign". */
export const RTA = 'rta'

export type Target =
  | { kind: 'monthly'; amount: number } // have this much each month: what's left over counts toward it, overspending is made up
  | { kind: 'topup'; amount: number } // add this much every month, whatever came over
  | { kind: 'refill'; amount: number } // the old name of 'topup', read as it (see buildIndex)
  | { kind: 'goal'; amount: number; by?: Month } // reach this total, optionally by a month

export interface Group extends Rec {
  name: string
  order: number
}

export interface Category extends Rec {
  name: string
  group: ID
  order: number
  target?: Target
  /** spread what's left over the remaining days of the month ("NT$135 for today") */
  daily?: boolean
  /** money given to this category counts as saved (savings rate) */
  saving?: boolean
  note?: string
  /** kept for history, hidden from everyday screens */
  archived?: 1
  /** an investment account: money spent from this (savings) category moves into it */
  acct?: ID
}

export interface Txn extends Rec {
  date: Day
  /** category id, or RTA for income */
  cat: ID
  /** amount as entered, in `cur`, signed: negative = money out */
  amt: number
  cur: string
  /** the same amount in the base currency at the rate of the day; this is what the budget uses */
  base: number
  note?: string
  /**
   * start = opening balance, adj = correction found while counting, fx = exchange-rate drift,
   * move = money moved between two accounts (base 0: the plan doesn't change)
   */
  kind?: 'start' | 'adj' | 'fx' | 'move'
  /** the account the money left or arrived in (only when accounts are tracked) */
  acct?: ID
  /** income: where it came from (a Source id) */
  src?: ID
  /** move: the account the money went to, and what arrived there in that account's currency (when it differs) */
  to?: ID
  toAmt?: number
  /** the Repeat this entry belongs to: the one it was set on, or one it logged */
  rep?: ID
}

/**
 * A payment that comes back (rent, a subscription, a yearly insurance): set on an entry, it logs a copy of
 * it by itself on the same day every month or year.
 */
export interface Repeat extends Rec {
  every: 'month' | 'year'
  /** the entry it was set on: its day of the month (or of the year) is when it comes back */
  from: Day
  /** it logs nothing on or before this day: what came before was logged by hand */
  after: Day
  /** what it logs: a copy of the entry it was set on, kept up to date with the latest one */
  cat: ID
  amt: number
  cur: string
  note?: string
  acct?: ID
  src?: ID
}

/** Money given to a category in a month. id = `${m}|${cat}` */
export interface Assign extends Rec {
  m: Month
  cat: ID
  amt: number
}

/** A place where money lives. Balances are only recorded when you count. */
export interface Account extends Rec {
  name: string
  cur: string
  order: number
  /** investments: wealth tracked by its value, never spent from or counted into the plan */
  invest?: 1
}

/** Where income comes from (salary, a client). Lives in Settings. */
export interface Source {
  id: ID
  name: string
}

/** A snapshot of every account's real balance, taken when you count your money. */
export interface Count extends Rec {
  date: Day
  bal: Record<ID, number>
  /** each account's currency at the time of the count */
  curs?: Record<ID, string>
  rates: Rates
  /** counted total in base currency */
  total: number
  /** what the budget expected before the correction */
  expected: number
  /** accounts not typed in this count: their balance was carried over from what was known */
  carried?: ID[]
}

/** Monthly reflection. id = month */
export interface Note extends Rec {
  text: string
}

export interface Settings extends Rec {
  base: string
  /** read from the rate table (see settingsOf); kept in this record only for older app versions */
  rates: Rates
  ratesAt: number
  /** user-set rates that live updates should not overwrite */
  pinned?: Record<string, 1>
  /** share of income to save, 0..1 */
  savingsTarget: number
  /** currencies offered on the keypad besides base */
  extraCurrencies: string[]
  /** onboarding finished */
  ready?: 1
  /** each transaction says which account it came from */
  trackAccounts?: 1
  /** where income comes from, in display order */
  sources?: Source[]
}

/** Live exchange rates. Machine data, kept apart from Settings so a background refresh never touches the user's choices. */
export interface RateTable extends Rec {
  /** one value, so the rates always travel with the budget currency they are for */
  table: { base: string; rates: Rates; at: number }
}

export interface DB {
  groups: Record<ID, Group>
  cats: Record<ID, Category>
  txns: Record<ID, Txn>
  assigns: Record<ID, Assign>
  accounts: Record<ID, Account>
  counts: Record<ID, Count>
  notes: Record<ID, Note>
  repeats: Record<ID, Repeat>
  meta: { settings?: Settings; rates?: RateTable }
}

export const COLLECTIONS = ['groups', 'cats', 'txns', 'assigns', 'accounts', 'counts', 'notes', 'repeats', 'meta'] as const
export type CollectionName = (typeof COLLECTIONS)[number]

export function emptyDB(): DB {
  return { groups: {}, cats: {}, txns: {}, assigns: {}, accounts: {}, counts: {}, notes: {}, repeats: {}, meta: {} }
}

export function live<T extends Rec>(coll: Record<ID, T>): T[] {
  return Object.values(coll).filter((r) => !r.d)
}
