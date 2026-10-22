import { beforeEach, describe, expect, it } from 'vitest'
import { ageAt, agePoints, budgetAges, spendAges } from '../src/lib/age'
import * as S from '../src/lib/store'
import { emptyDB, RTA, type Txn } from '../src/lib/types'

let seq = 0
/** A transaction in whole units, written in call order. */
function tx(date: string, cat: string, major: number, extra: Partial<Txn> = {}): Txn {
  seq++
  return { id: `t${seq}`, u: seq, date, cat, amt: major * 100, cur: 'TWD', base: major * 100, ...extra }
}
const none = () => false
const ages = (txns: Txn[], invest: (cat: string) => boolean = none) => spendAges(txns, invest).map((s) => Math.round(s.age * 10) / 10)

describe('spending ages', () => {
  it('spends the oldest money first', () => {
    const txns = [
      tx('2026-01-01', RTA, 1000),
      tx('2026-01-31', RTA, 1000),
      tx('2026-02-10', 'food', -500), // all from Jan 1: 40 days
      tx('2026-02-10', 'food', -1000), // 500 from Jan 1 (40) + 500 from Jan 31 (10)
    ]
    expect(ages(txns)).toEqual([40, 25])
  })

  it('ignores the order transactions come in', () => {
    const a = [tx('2026-01-01', RTA, 1000), tx('2026-01-11', 'food', -100)]
    expect(ages([...a].reverse())).toEqual([10])
  })

  it('takes money put into investments from the newest, without counting it', () => {
    const txns = [
      tx('2026-01-01', RTA, 1000),
      tx('2026-02-01', RTA, 1000),
      tx('2026-02-02', 'invest', -1000), // the February pay goes to investments
      tx('2026-02-11', 'food', -100),
    ]
    // food still uses January's money: investing doesn't make what's left look younger
    expect(ages(txns, (c) => c === 'invest')).toEqual([41])
    // as plain spending it would have used January's money, and food the newer pay
    expect(ages(txns)).toEqual([32, 10])
  })

  it('skips moves and does not count corrections as spending', () => {
    const txns = [
      tx('2026-01-01', RTA, 1000, { kind: 'start' }),
      tx('2026-01-05', RTA, 0, { kind: 'move', amt: -300 }),
      tx('2026-01-10', RTA, -400, { kind: 'adj' }), // money that wasn't there: uses up the oldest
      tx('2026-01-15', RTA, 500),
      tx('2026-01-20', RTA, 50, { kind: 'fx' }),
      tx('2026-01-21', 'food', -800), // 600 from Jan 1 (20), 200 from Jan 15 (6)
    ]
    expect(ages(txns)).toEqual([16.5])
  })

  it('counts a refund as money coming in', () => {
    const txns = [tx('2026-01-01', RTA, 100), tx('2026-01-10', 'shop', 200), tx('2026-01-20', 'food', -300)]
    // 100 from Jan 1 (19 days) + 200 from the Jan 10 refund (10 days)
    expect(ages(txns)).toEqual([13])
  })

  it('treats money spent before it came in as new, and repays it from the next inflow', () => {
    const txns = [
      tx('2026-01-01', RTA, 100),
      tx('2026-01-11', 'food', -300), // 100 at 10 days, 200 never came in
      tx('2026-01-20', RTA, 500), // 200 repays, 300 is new money
      tx('2026-01-30', 'food', -300),
    ]
    expect(ages(txns)).toEqual([3.3, 10])
  })
})

describe('age at a point in time', () => {
  const spends = [
    { date: '2026-01-10', amount: 100, age: 10 },
    { date: '2026-01-20', amount: 300, age: 30 },
    { date: '2026-02-05', amount: 100, age: 50 },
  ]

  it('averages the last spendings by amount', () => {
    expect(ageAt(spends, '2026-01-31')).toBe(25)
    expect(ageAt(spends, '2026-02-28')).toBe(30)
    expect(ageAt(spends, '2026-02-28', 2)).toBe(35)
    expect(ageAt(spends, '2026-01-05')).toBeNull()
  })

  it('gives each month its value at the month end, or today', () => {
    expect(agePoints(spends, ['2025-12', '2026-01', '2026-02'], '2026-02-01')).toEqual([
      { month: '2025-12', days: null },
      { month: '2026-01', days: 25 },
      { month: '2026-02', days: 25 },
    ])
  })
})

describe('from the budget', () => {
  beforeEach(() => {
    S.replaceDB(emptyDB())
    S.updateSettings({ base: 'TWD', rates: {}, savingsTarget: 0.2 })
    S.seedCategories()
  })

  it('treats spending from a category linked to an investment account as investing', () => {
    const cat = (name: string) => Object.values(S.getDB().cats).find((c) => c.name === name)!
    const acct = S.addAccount('Brokerage', 'TWD', { invest: true })
    S.saveCategory({ ...cat('Future me'), acct: acct.id })
    S.addTxn({ date: '2026-01-01', cat: RTA, amt: 100000, cur: 'TWD' })
    S.addTxn({ date: '2026-02-01', cat: RTA, amt: 100000, cur: 'TWD' })
    S.addTxn({ date: '2026-02-02', cat: cat('Future me').id, amt: -100000, cur: 'TWD' })
    S.addTxn({ date: '2026-02-11', cat: cat('Living').id, amt: -10000, cur: 'TWD' })
    // Emergency isn't linked: spending from it is spending
    S.addTxn({ date: '2026-02-21', cat: cat('Emergency').id, amt: -10000, cur: 'TWD' })
    expect(budgetAges(S.getIndex()).map((s) => s.age)).toEqual([41, 51])
  })
})
