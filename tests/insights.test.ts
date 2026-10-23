import { beforeEach, describe, expect, it } from 'vitest'
import { monthView } from '../src/lib/budget'
import { savedLine, savingsRate, totalPlanned, wealth } from '../src/lib/insights'
import * as S from '../src/lib/store'
import { emptyDB, RTA, type Category, type Target } from '../src/lib/types'

const AUG = '2026-08'
const SEP = '2026-09'
const OCT = '2026-10'
const NOV = '2026-11'
const TODAY = '2026-10-15'

function cat(name: string): Category {
  return Object.values(S.getDB().cats).find((c) => c.name === name)!
}
/** whole currency units -> minor */
const u = (major: number) => major * 100
function spend(date: string, name: string, major: number) {
  S.addTxn({ date, cat: cat(name).id, amt: -u(major), cur: 'TWD' })
}
function earn(date: string, major: number) {
  S.addTxn({ date, cat: RTA, amt: u(major), cur: 'TWD' })
}
function give(month: string, name: string, major: number) {
  S.setAssigned(month, cat(name).id, u(major))
}
function target(name: string, t: Target) {
  S.saveCategory({ ...cat(name), target: t })
}
const ix = () => S.getIndex()
const planned = (month: string) => totalPlanned(monthView(ix(), month, OCT))

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: { EUR: 36 }, savingsTarget: 0.2 })
  S.seedCategories()
})

describe('planned spending', () => {
  it('counts what each category had for its own month, savings left out', () => {
    earn('2026-09-01', 60000)
    give(SEP, 'Living', 15000)
    give(SEP, 'Purchases', 5000)
    give(SEP, 'Future me', 12000)
    spend('2026-09-03', 'Living', 16000) // 1,000 over
    spend('2026-09-04', 'Purchases', 2000)
    spend('2026-09-05', 'Trips', 3000) // nothing assigned: carries -3,000
    give(OCT, 'Living', 15000)
    give(OCT, 'Purchases', 5000)
    give(OCT, 'Trips', 1000)
    give(NOV, 'Living', 15000)
    expect(planned(SEP)).toBe(u(20000))
    // Living −1,000 + 15,000; Purchases 3,000 + 5,000; Trips −3,000 + 1,000 clamps to 0
    expect(planned(OCT)).toBe(u(14000 + 8000))
    // November: Living carries 14,000 and gets 15,000 more, Purchases carries 8,000
    expect(planned(NOV)).toBe(u(29000 + 8000))
  })

  it('leaves money kept toward a goal or buffer out, until it is spent', () => {
    target('Trips', { kind: 'goal', amount: u(30000), by: '2027-01' })
    target('Other', { kind: 'refill', amount: u(5000) })
    target('Living', { kind: 'refill', amount: u(10000) }) // daily: meant to be spent
    give(SEP, 'Trips', 5000)
    give(SEP, 'Other', 5000)
    give(SEP, 'Living', 10000)
    spend('2026-09-04', 'Living', 8000)
    spend('2026-09-05', 'Other', 1000)
    expect(planned(SEP)).toBe(u(10000 + 1000))
    spend('2026-09-20', 'Trips', 2000)
    expect(planned(SEP)).toBe(u(10000 + 1000 + 2000))
  })

  it('does not count money that cleared earlier overspending', () => {
    spend('2026-08-05', 'Purchases', 3000) // nothing assigned: −3,000
    give(SEP, 'Purchases', 8000) // 3,000 clears August, 5,000 for September
    spend('2026-09-05', 'Purchases', 5000)
    expect(planned(SEP)).toBe(u(5000))
  })
})

describe('saving', () => {
  it('says the rate against the target', () => {
    earn('2026-09-01', 50000)
    give(SEP, 'Future me', 9000)
    expect(savedLine(ix(), SEP, TODAY)).toEqual({ text: 'Saved 18% of income\u2003target 20%', good: false, rate: '18%' })
    give(SEP, 'Emergency', 1000)
    expect(savedLine(ix(), SEP, TODAY)).toMatchObject({ text: 'Saved 20% of income\u2003target 20%', good: true })
    S.updateSettings({ savingsTarget: 0 })
    expect(savedLine(ix(), SEP, TODAY)!.text).toBe('Saved 20% of income')
  })

  it('has no rate when savings were more than the income, and says when savings were taken out', () => {
    S.addTxn({ date: '2026-09-01', cat: RTA, amt: u(100000), cur: 'TWD', kind: 'start' })
    earn('2026-09-02', 20000)
    give(SEP, 'Future me', 30000)
    expect(savingsRate(monthView(ix(), SEP, OCT))).toBeNull()
    expect(savedLine(ix(), SEP, TODAY)).toMatchObject({ text: 'Saved NT$30,000, more than came in', good: true })
    give(OCT, 'Future me', -5000)
    expect(savedLine(ix(), OCT, TODAY)).toMatchObject({ text: 'Took NT$5,000 out of savings', good: false })
    expect(savedLine(ix(), AUG, TODAY)).toBeNull()
  })
})

describe('wealth', () => {
  it('is nothing without data', () => {
    expect(wealth(ix(), OCT, TODAY)).toBeNull()
  })

  it('follows net worth, and splits investments into money put in and growth', () => {
    const bank = S.addAccount('Bank', 'TWD')
    const fund = S.addAccount('Fund', 'TWD', { invest: true })
    // the fund's value is first typed in August: that is money it held, not growth
    S.recordCount({ date: '2026-08-10', bal: { [bank.id]: u(500000), [fund.id]: u(200000) }, rates: S.settings().rates, diffTo: RTA })
    S.saveCategory({ ...cat('Future me'), acct: fund.id })
    give(SEP, 'Future me', 10000)
    spend('2026-09-05', 'Future me', 10000) // put in
    S.recordCount({ date: '2026-09-30', bal: { [fund.id]: u(215000) }, rates: S.settings().rates, diffTo: RTA })
    spend('2026-10-03', 'Living', 2000)
    S.recordCount({ date: '2026-10-12', bal: { [fund.id]: u(212000) }, rates: S.settings().rates, diffTo: RTA })

    const w = wealth(ix(), OCT, TODAY)!
    expect(w.points.map((p) => p.month)).toEqual([AUG, SEP, OCT])
    expect(w.points.map((p) => p.total)).toEqual([u(700000), u(705000), u(700000)])
    expect(w.change).toBe(0)
    expect(w.added).toBe(u(10000))
    // September: 200,000 → 215,000 with 10,000 put in = +5,000; October: −3,000
    expect(w.growth).toBe(u(2000))
    // a window that starts later
    expect(wealth(ix(), OCT, TODAY, 2)!.points.map((p) => p.month)).toEqual([SEP, OCT])
  })

  it('has no growth without investment accounts', () => {
    earn('2026-09-01', 1000)
    earn('2026-10-01', 2000)
    const w = wealth(ix(), OCT, TODAY)!
    expect(w.points.map((p) => p.total)).toEqual([u(1000), u(3000)])
    expect(w.change).toBe(u(2000))
    expect(w.growth).toBeNull()
  })
})
