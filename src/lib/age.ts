// Age of money (YNAB's idea): on average, how many days money sits between coming in and going out.
//
// Money is a queue of dated inflows: income, opening balances, corrections and refunds that added money.
// Spending takes the oldest money first (FIFO) and is as old as the money it used. The age at a point in
// time is the amount-weighted average over the last few spendings up to it.
//
// Saving shouldn't look like a bad habit:
// - money put into investments (spending from a category linked to an investment account) takes the
//   newest money (LIFO) and isn't averaged, so the buffer left behind keeps its age;
// - moves between accounts change nothing; corrections and exchange-rate drift that took money away
//   use up the oldest money without counting as spending.
// Spending money that never came in (more out than in so far) is 0 days old, and later inflows repay it first.

import type { Index } from './budget'
import { daysInMonth } from './dates'
import { RTA, type Day, type ID, type Month, type Txn } from './types'

/** A spending: how much went out on a day, and how many days old that money was. */
export interface Spend {
  date: Day
  amount: number
  age: number
}

/** How many spendings the age averages over. */
export const AGE_WINDOW = 10

const dayNo = (d: Day) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000

/** Every spending with the age of the money it used, oldest first. `invest`: categories that put money into investments. */
export function spendAges(txns: Txn[], invest: (cat: ID) => boolean): Spend[] {
  const asc = txns.filter((t) => !t.d && t.kind !== 'move' && t.base).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.u - b.u))
  // the queue: dated amounts not spent yet, oldest at `head`
  const dates: number[] = []
  const left: number[] = []
  let head = 0
  let owed = 0
  const out: Spend[] = []

  /** Take `amount` from the oldest (or newest) money; returns Σ amount × days for what it found. */
  const take = (amount: number, day: number, newest: boolean) => {
    let need = amount
    let weighted = 0
    while (need > 0 && head < left.length) {
      const k = newest ? left.length - 1 : head
      const used = Math.min(need, left[k])
      weighted += used * (day - dates[k])
      need -= used
      left[k] -= used
      if (left[k] > 0) continue
      if (newest) {
        left.pop()
        dates.pop()
      } else head++
    }
    owed += need
    return weighted
  }

  for (const t of asc) {
    const day = dayNo(t.date)
    if (t.base > 0) {
      const repay = Math.min(owed, t.base)
      owed -= repay
      if (t.base > repay) {
        dates.push(day)
        left.push(t.base - repay)
      }
      continue
    }
    const amount = -t.base
    if (t.cat === RTA || t.kind) take(amount, day, false)
    else if (invest(t.cat)) take(amount, day, true)
    else out.push({ date: t.date, amount, age: take(amount, day, false) / amount })
  }
  return out
}

/** The age of money on a day: the amount-weighted age of the last `n` spendings up to it. Null before any spending. */
export function ageAt(spends: Spend[], date: Day, n = AGE_WINDOW): number | null {
  let end = spends.length
  while (end > 0 && spends[end - 1].date > date) end--
  if (!end) return null
  let amount = 0
  let weighted = 0
  for (let k = Math.max(0, end - n); k < end; k++) {
    amount += spends[k].amount
    weighted += spends[k].amount * spends[k].age
  }
  return amount > 0 ? weighted / amount : null
}

export interface AgePoint {
  month: Month
  /** days, at the month's end (today for the current one); null before any spending */
  days: number | null
}

/** Spending ages over the whole budget. Investing is spending from a category linked to an investment account. */
export function budgetAges(ix: Index): Spend[] {
  return spendAges(ix.txns, (cat) => !!ix.catById.get(cat)?.acct)
}

/** The age of money at the end of each month (today for the current one), in whole days. */
export function agePoints(spends: Spend[], months: Month[], today: Day): AgePoint[] {
  return months.map((m) => {
    const last = `${m}-${String(daysInMonth(m)).padStart(2, '0')}`
    const days = ageAt(spends, last < today ? last : today)
    return { month: m, days: days === null ? null : Math.round(days) }
  })
}
