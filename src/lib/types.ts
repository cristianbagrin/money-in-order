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
}

/** Pseudo-category for income and anything else that feeds "Ready to Assign". */
export const RTA = 'rta'

export type Target =
  | { kind: 'monthly'; amount: number } // set aside this much every month
  | { kind: 'refill'; amount: number } // top the category up to this much
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
  /** start = opening balance, adj = correction found while counting, fx = exchange-rate drift */
  kind?: 'start' | 'adj' | 'fx'
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
}

/** Monthly reflection. id = month */
export interface Note extends Rec {
  text: string
}

export interface Settings extends Rec {
  base: string
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
}

export interface DB {
  groups: Record<ID, Group>
  cats: Record<ID, Category>
  txns: Record<ID, Txn>
  assigns: Record<ID, Assign>
  accounts: Record<ID, Account>
  counts: Record<ID, Count>
  notes: Record<ID, Note>
  meta: Record<ID, Settings>
}

export const COLLECTIONS = ['groups', 'cats', 'txns', 'assigns', 'accounts', 'counts', 'notes', 'meta'] as const
export type CollectionName = (typeof COLLECTIONS)[number]

export function emptyDB(): DB {
  return { groups: {}, cats: {}, txns: {}, assigns: {}, accounts: {}, counts: {}, notes: {}, meta: {} }
}

export function live<T extends Rec>(coll: Record<ID, T>): T[] {
  return Object.values(coll).filter((r) => !r.d)
}
