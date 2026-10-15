import { beforeEach, describe, expect, it } from 'vitest'
import { daily, expectedTotal, fundingPlan, monthView, targetNeed } from '../src/lib/budget'
import { merge, hasNews } from '../src/lib/merge'
import { fmt, keypadToMinor, parseAmount, convert } from '../src/lib/money'
import * as S from '../src/lib/store'
import { emptyDB, RTA, type Category } from '../src/lib/types'

const OCT = '2026-10'
const NOV = '2026-11'

function catByName(name: string): Category {
  return Object.values(S.getDB().cats).find((c) => c.name === name)!
}

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: { EUR: 36.16, PLN: 8.29 } })
  S.seedCategories()
})

describe('money', () => {
  it('formats per currency', () => {
    expect(fmt(560000, 'TWD')).toBe('NT$5,600')
    expect(fmt(-131300, 'TWD')).toBe('−NT$1,313')
    expect(fmt(59800, 'EUR')).toBe('€598')
    expect(fmt(5950, 'EUR')).toBe('€59.50')
    expect(fmt(649300, 'PLN')).toBe('6,493 zł')
    expect(fmt(1200, 'TWD', { sign: true })).toBe('+NT$12')
  })
  it('parses typed amounts', () => {
    expect(parseAmount('1,250.5')).toBe(125050)
    expect(parseAmount('1250,50')).toBe(125050)
    expect(parseAmount('12')).toBe(1200)
    expect(parseAmount('-3')).toBe(-300)
    expect(parseAmount('')).toBe(null)
    expect(keypadToMinor('12.5')).toBe(1250)
    expect(keypadToMinor('125')).toBe(12500)
  })
  it('converts through the base currency', () => {
    const rates = { EUR: 36.16, PLN: 8.29 }
    expect(convert(10000, 'EUR', 'TWD', rates, 'TWD')).toBe(361600)
    expect(convert(361600, 'TWD', 'EUR', rates, 'TWD')).toBe(10000)
    expect(convert(10000, 'EUR', 'PLN', rates, 'TWD')).toBe(Math.round((10000 * 36.16) / 8.29))
  })
})

describe('budget math', () => {
  it('income goes to Ready to Assign, assigning takes it out', () => {
    S.addTxn({ date: '2026-10-01', cat: RTA, amt: 6000000, cur: 'TWD' })
    const living = catByName('Living')
    S.setAssigned(OCT, living.id, 600000)
    const v = monthView(S.getIndex(), OCT, OCT)
    expect(v.readyToAssign).toBe(5400000)
    expect(v.byId.get(living.id)!.available).toBe(600000)
    expect(v.income).toBe(6000000)
  })

  it('rolls leftovers and overspending into next month', () => {
    const living = catByName('Living')
    const purchases = catByName('Purchases')
    S.addTxn({ date: '2026-10-01', cat: RTA, amt: 10000000, cur: 'TWD' })
    S.setAssigned(OCT, living.id, 600000)
    S.setAssigned(OCT, purchases.id, 1000000)
    S.addTxn({ date: '2026-10-03', cat: living.id, amt: -400000, cur: 'TWD' })
    S.addTxn({ date: '2026-10-05', cat: purchases.id, amt: -1550000, cur: 'TWD' })
    const nov = monthView(S.getIndex(), NOV, OCT)
    expect(nov.byId.get(living.id)!.carry).toBe(200000)
    expect(nov.byId.get(purchases.id)!.carry).toBe(-550000)
    expect(nov.byId.get(purchases.id)!.available).toBe(-550000)
    const oct = monthView(S.getIndex(), OCT, OCT)
    expect(oct.overspent.map((c) => c.cat.name)).toEqual(['Purchases'])
    expect(oct.spent).toBe(1950000)
  })

  it('keeps the invariant: money = ready to assign + everything available', () => {
    const ids = Object.values(S.getDB().cats).map((c) => c.id)
    S.addTxn({ date: '2026-09-01', cat: RTA, amt: 5000000, cur: 'TWD' })
    S.addTxn({ date: '2026-10-01', cat: RTA, amt: 70000, cur: 'EUR' })
    S.setAssigned('2026-09', ids[0], 300000)
    S.setAssigned(OCT, ids[1], 120000)
    S.setAssigned(NOV, ids[2], 50000)
    S.addTxn({ date: '2026-09-12', cat: ids[0], amt: -450000, cur: 'TWD' })
    S.addTxn({ date: '2026-10-02', cat: ids[1], amt: -5000, cur: 'PLN' })
    const ix = S.getIndex()
    // In October, the 50,000 already given to November is held aside too.
    const oct = monthView(ix, OCT, OCT)
    expect(oct.readyToAssign + oct.available + 50000).toBe(expectedTotal(ix))
    const nov = monthView(ix, NOV, OCT)
    expect(nov.readyToAssign + nov.available).toBe(expectedTotal(ix))
  })

  it('money assigned to a future month is not ready to assign today', () => {
    const trips = catByName('Trips')
    S.addTxn({ date: '2026-10-01', cat: RTA, amt: 1000000, cur: 'TWD' })
    S.setAssigned(NOV, trips.id, 400000)
    expect(monthView(S.getIndex(), OCT, OCT).readyToAssign).toBe(600000)
    // Looking back at a past month shows what it was then.
    expect(monthView(S.getIndex(), OCT, '2026-12').readyToAssign).toBe(1000000)
  })

  it('moves money between categories', () => {
    const living = catByName('Living')
    const other = catByName('Other')
    S.addTxn({ date: '2026-10-01', cat: RTA, amt: 1000000, cur: 'TWD' })
    S.setAssigned(OCT, living.id, 500000)
    S.moveMoney(OCT, living.id, other.id, 120000)
    S.moveMoney(OCT, RTA, other.id, 10000)
    const v = monthView(S.getIndex(), OCT, OCT)
    expect(v.byId.get(living.id)!.assigned).toBe(380000)
    expect(v.byId.get(other.id)!.assigned).toBe(130000)
    expect(v.readyToAssign).toBe(490000)
  })
})

describe('targets', () => {
  const cat = (target: Category['target']): Category => ({ id: 'x', u: 0, name: 'x', group: 'g', order: 0, target })

  it('monthly: the full amount every month, plus any debt', () => {
    expect(targetNeed(cat({ kind: 'monthly', amount: 60000 }), 20000, 0, OCT)).toEqual({ need: 60000, goal: 60000 })
    expect(targetNeed(cat({ kind: 'monthly', amount: 60000 }), -10000, 30000, OCT)).toEqual({ need: 40000, goal: 70000 })
  })
  it('refill: top up to the amount', () => {
    expect(targetNeed(cat({ kind: 'refill', amount: 600000 }), 228800, 0, OCT)).toEqual({ need: 371200, goal: 371200 })
    expect(targetNeed(cat({ kind: 'refill', amount: 600000 }), 700000, 0, OCT).need).toBe(0)
  })
  it('goal by date: spread over the months left', () => {
    const r = targetNeed(cat({ kind: 'goal', amount: 3000000, by: '2026-12' }), 0, 0, OCT)
    expect(r.need).toBe(1000000)
    expect(targetNeed(cat({ kind: 'goal', amount: 3000000, by: '2026-12' }), 3000000, 0, OCT).need).toBe(0)
  })

  it('fund targets fills in budget order until money runs out', () => {
    const living = catByName('Living')
    const phone = catByName('Phone')
    S.saveCategory({ ...living, target: { kind: 'refill', amount: 600000 } })
    S.saveCategory({ ...phone, target: { kind: 'monthly', amount: 60000 } })
    S.addTxn({ date: '2026-10-01', cat: RTA, amt: 620000, cur: 'TWD' })
    const plan = fundingPlan(monthView(S.getIndex(), OCT, OCT))
    expect(plan).toEqual([
      { cat: living.id, amount: 600000 },
      { cat: phone.id, amount: 20000 },
    ])
    S.fundTargets(OCT, OCT)
    expect(monthView(S.getIndex(), OCT, OCT).readyToAssign).toBe(0)
  })
})

describe('daily allowance', () => {
  it('spreads what is left over the remaining days', () => {
    const living = catByName('Living')
    S.addTxn({ date: '2026-10-01', cat: RTA, amt: 1000000, cur: 'TWD' })
    S.setAssigned(OCT, living.id, 600000)
    S.addTxn({ date: '2026-10-03', cat: living.id, amt: -371200, cur: 'TWD' })
    // 15 Oct: 228,800 minor left, 17 days including today
    let d = daily(S.getIndex(), monthView(S.getIndex(), OCT, OCT), '2026-10-15')!
    expect(d.daysLeft).toBe(17)
    expect(d.allowance).toBe(13400) // NT$134.58 -> NT$134
    expect(d.leftToday).toBe(13400)
    S.addTxn({ date: '2026-10-15', cat: living.id, amt: -10000, cur: 'TWD' })
    d = daily(S.getIndex(), monthView(S.getIndex(), OCT, OCT), '2026-10-15')!
    expect(d.allowance).toBe(13400)
    expect(d.leftToday).toBe(3400)
    expect(d.spentToday).toBe(10000)
    expect(d.tomorrow).toBe(13600) // 218,800 / 16
  })
})

describe('counting money', () => {
  it('first count sets the starting balance', () => {
    const cash = S.addAccount('Cash', 'TWD')
    const rev = S.addAccount('Revolut', 'PLN')
    const r = S.recordCount({ date: '2026-10-01', bal: { [cash.id]: 1640000, [rev.id]: 340000 }, rates: { PLN: 8.29 }, diffTo: RTA })
    expect(r.first).toBe(true)
    expect(r.total).toBe(1640000 + Math.round(340000 * 8.29))
    const v = monthView(S.getIndex(), OCT, OCT)
    expect(v.readyToAssign).toBe(r.total)
    expect(v.income).toBe(0)
  })

  it('later counts split exchange-rate drift from unlogged spending', () => {
    const cash = S.addAccount('Cash', 'TWD')
    const rev = S.addAccount('Revolut', 'PLN')
    const living = catByName('Living')
    S.recordCount({ date: '2026-10-01', bal: { [cash.id]: 1000000, [rev.id]: 100000 }, rates: { PLN: 8 }, diffTo: RTA })
    S.addTxn({ date: '2026-10-05', cat: living.id, amt: -50000, cur: 'TWD' })
    // Really spent 80,000 cash (30,000 unlogged) and the zloty rose to 8.5
    const r = S.recordCount({ date: '2026-11-01', bal: { [cash.id]: 920000, [rev.id]: 100000 }, rates: { PLN: 8.5 }, diffTo: living.id })
    expect(r.fx).toBe(50000)
    expect(r.diff).toBe(-30000)
    const ix = S.getIndex()
    expect(expectedTotal(ix)).toBe(920000 + 850000)
    expect(monthView(ix, NOV, NOV).byId.get(living.id)!.activity).toBe(-30000)
  })
})

describe('sync merge', () => {
  it('newest record wins, deletions included, in any order', () => {
    const a = emptyDB()
    const b = emptyDB()
    a.txns.t1 = { id: 't1', u: 1, date: '2026-10-01', cat: 'c', amt: -1, cur: 'TWD', base: -1 }
    b.txns.t1 = { ...a.txns.t1, u: 2, d: 1 }
    b.txns.t2 = { id: 't2', u: 3, date: '2026-10-02', cat: 'c', amt: -2, cur: 'TWD', base: -2 }
    a.assigns['2026-10|c'] = { id: '2026-10|c', u: 5, m: '2026-10', cat: 'c', amt: 100 }
    b.assigns['2026-10|c'] = { id: '2026-10|c', u: 4, m: '2026-10', cat: 'c', amt: 50 }
    const ab = merge(a, b)
    const ba = merge(b, a)
    expect(ab).toEqual(ba)
    expect(ab.txns.t1.d).toBe(1)
    expect(ab.assigns['2026-10|c'].amt).toBe(100)
    expect(merge(ab, a)).toEqual(ab)
    expect(hasNews(ab, a)).toBe(false)
    expect(hasNews(a, ab)).toBe(true)
  })
})
