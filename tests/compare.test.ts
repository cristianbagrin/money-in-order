import { beforeEach, describe, expect, it } from 'vitest'
import { advice, byChange, change, goalLine, goals, monthsBefore, rangeName, roundPlan, settledMonths } from '../src/lib/compare'
import { categoryTrends, spendingTrend } from '../src/lib/insights'
import * as S from '../src/lib/store'
import { emptyDB, RTA, type Category, type Target } from '../src/lib/types'

const AUG = '2026-08'
const SEP = '2026-09'
const OCT = '2026-10'
const NOV = '2026-11'

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
const texts = (month: string, today: string) => advice(ix(), month, today).items.map((n) => n.text)

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: {}, savingsTarget: 0.2 })
  S.seedCategories()
})

describe('helpers', () => {
  it('rounds to numbers you would plan with', () => {
    expect(roundPlan(u(17234))).toBe(u(17500))
    expect(roundPlan(u(17234), 'near')).toBe(u(17000))
    expect(roundPlan(u(1234))).toBe(u(1250))
    expect(roundPlan(u(1234), 'down')).toBe(u(1200))
    expect(roundPlan(u(600))).toBe(u(600))
    expect(roundPlan(u(17500))).toBe(u(17500))
    expect(roundPlan(0)).toBe(0)
  })

  it('names a run of months', () => {
    expect(rangeName([AUG, SEP, OCT])).toBe('Aug–Oct')
    expect(rangeName(['2025-12', '2026-01'])).toBe('Dec 2025–Jan 2026')
    expect(rangeName([SEP])).toBe('Sep')
  })

  it('takes only finished months, up to the month shown', () => {
    spend('2026-07-03', 'Living', 100)
    expect(settledMonths(ix(), NOV, '2026-11-10')).toEqual([AUG, SEP, OCT])
    expect(settledMonths(ix(), SEP, '2026-11-10')).toEqual(['2026-07', AUG, SEP])
    expect(settledMonths(ix(), AUG, '2026-11-10')).toEqual(['2026-07', AUG]) // data starts in July
    expect(settledMonths(ix(), '2026-12', '2026-11-10')).toEqual([])
    expect(monthsBefore(ix(), NOV)).toBe(3)
    expect(monthsBefore(ix(), AUG)).toBe(1)
  })
})

describe('month against month', () => {
  it('compares a finished month with the one before and with a typical month', () => {
    give(AUG, 'Living', 15000)
    spend('2026-08-05', 'Living', 10000)
    spend('2026-09-05', 'Living', 14000)
    spend('2026-10-05', 'Living', 11000)
    spend('2026-11-05', 'Living', 9000)
    spend('2026-11-06', 'Purchases', 3000)
    const t = categoryTrends(ix(), NOV, '2026-12-02', 6)
    const living = t.find((x) => x.name === 'Living')!
    expect(living.last).toBe(u(11000))
    expect(living.usual).toBe(u(11000)) // median of 10,000, 14,000 and 11,000
    // Purchases was never used before November: nothing typical to compare with, last month was zero
    const purchases = t.find((x) => x.name === 'Purchases')!
    expect(purchases.usual).toBeNull()
    expect(purchases.last).toBe(0)
    expect(change(purchases, 'last')).toEqual({ then: 0, diff: u(3000), same: false })
    expect(change(living, 'usual')).toEqual({ then: u(11000), diff: -u(2000), same: false })
    // biggest move in money first
    expect(byChange(t, 'usual').map((x) => x.name)).toEqual(['Living', 'Purchases'])
    expect(byChange(t, 'last').map((x) => x.name)).toEqual(['Purchases', 'Living'])

    const all = spendingTrend(ix(), NOV, '2026-12-02')
    expect(all).toEqual({ thisMonth: u(12000), last: u(11000), usual: u(11000), planned: 0 }) // August's plan is long spent
  })

  it('compares the current month with the same point of the months before', () => {
    spend('2026-09-05', 'Living', 1000)
    spend('2026-09-25', 'Living', 9000)
    spend('2026-10-05', 'Living', 2000)
    spend('2026-10-20', 'Living', 9000)
    spend('2026-11-04', 'Living', 1500)
    const all = spendingTrend(ix(), NOV, '2026-11-15')
    expect(all.thisMonth).toBe(u(1500))
    expect(all.last).toBe(u(2000)) // by October 15
    expect(all.usual).toBe(u(1500)) // the middle of 1,000 and 2,000
    expect(change(all, 'usual').same).toBe(true)
  })
})

describe('advice', () => {
  /** Three months of the same budget: 60,000 in, Living over its 15,000 every month, Phone well under. */
  function months(opts: { living?: number; phone?: number; future?: number } = {}) {
    for (const m of [AUG, SEP, OCT]) {
      earn(`${m}-01`, 60000)
      give(m, 'Living', 15000)
      give(m, 'Phone', 1000)
      give(m, 'Future me', opts.future ?? 6000)
      spend(`${m}-10`, 'Living', opts.living ?? 17200)
      spend(`${m}-11`, 'Phone', opts.phone ?? 400)
    }
  }

  it('needs two finished months', () => {
    earn('2026-10-01', 60000)
    give(OCT, 'Living', 100)
    spend('2026-10-10', 'Living', 5000)
    expect(advice(ix(), OCT, '2026-10-15').items).toEqual([])
    expect(advice(ix(), NOV, '2026-11-10').items).toEqual([])
  })

  it('suggests plans that fit, what the savings rate could be, and money with no job', () => {
    months()
    const r = advice(ix(), NOV, '2026-11-10')
    expect(r.months).toEqual([AUG, SEP, OCT])
    // 60,000 − 22,000 assigned, plus Phone's spare 600, less Living's extra 2,500
    expect(r.free).toBe(u(36100))
    expect(r.items.map((n) => n.text)).toEqual([
      'Living went over every month: it costs about NT$17,000, not NT$15,000. Plan NT$17,500.',
      'Phone used about NT$400 of its NT$1,000 each month. Plan NT$400 and NT$600 a month is free.',
      'On average you saved 10% of your income; NT$6,000 more a month reaches 20%, and about NT$36,000 a month is left over with these plans.',
      'NT$114,000 is still in Ready to assign. If you won’t need it this month, give it to Future me.',
    ])
    expect(r.items[0].tone).toBe('bad')
    expect(r.items[1].tone).toBe('good')
  })

  it('looks back from a past month, without the figure that is only true now', () => {
    months()
    const sep = texts(SEP, '2026-11-10')
    expect(sep).toHaveLength(3)
    expect(sep[0]).toBe('Living went over every month: it costs about NT$17,000, not NT$15,000. Plan NT$17,500.')
    expect(sep.some((t) => t.includes('Ready to assign'))).toBe(false)
  })

  it('says when there is room to save more than the target', () => {
    months({ living: 14800, phone: 1000, future: 15000 })
    expect(texts(OCT, '2026-11-10')).toEqual([
      'On average you saved 25% of your income, above your 20% target, and about NT$29,000 a month is left over. Giving it to Future me would make it 73%.',
    ])
  })

  it('is honest when there is no room', () => {
    for (const m of [AUG, SEP, OCT]) {
      earn(`${m}-01`, 30000)
      give(m, 'Living', 24000)
      give(m, 'Purchases', 3000)
      give(m, 'Future me', 3000)
      spend(`${m}-10`, 'Living', 24000)
      spend(`${m}-11`, 'Purchases', 3000)
    }
    expect(texts(OCT, '2026-11-10')).toEqual(['On average you saved 10% of your income. Reaching 20% means spending NT$3,000 less a month.'])
  })

  it('leaves goals and buffers alone: their money is meant to pile up', () => {
    target('Trips', { kind: 'goal', amount: u(30000) })
    for (const m of [AUG, SEP, OCT]) {
      give(m, 'Trips', 3000)
      spend(`${m}-11`, 'Trips', 100)
    }
    expect(texts(OCT, '2026-11-10')).toEqual([])
  })
})

describe('goals', () => {
  it('shows progress and when a goal gets there', () => {
    target('Trips', { kind: 'goal', amount: u(30000), by: '2027-01' })
    target('Emergency', { kind: 'refill', amount: u(10000) })
    target('Other', { kind: 'goal', amount: u(5000) })
    for (const m of [AUG, SEP, OCT]) give(m, 'Trips', 4000)
    give(AUG, 'Emergency', 12000)
    give(AUG, 'Other', 1000)
    const gs = goals(ix(), OCT, '2026-10-15')
    const trips = gs.find((g) => g.name === 'Trips')!
    expect(trips).toMatchObject({ saved: u(12000), pace: u(4000), eta: '2027-03', needed: u(6000), status: 'behind' })
    expect(goalLine(trips, 'TWD', OCT)).toBe('NT$6,000 a month to make Jan 2027')
    const emergency = gs.find((g) => g.name === 'Emergency')!
    expect(emergency.status).toBe('done')
    expect(goalLine(emergency, 'TWD', OCT)).toBe('Reached')
    // 1,000 given in August, nothing in September; October, still going, counts once something is given to it
    const other = gs.find((g) => g.name === 'Other')!
    expect(other).toMatchObject({ status: 'open', pace: u(500), eta: '2027-06' })
    expect(goalLine(other, 'TWD', OCT)).toBe('Jun 2027 at this pace')

    give(NOV, 'Trips', 10000)
    expect(goals(ix(), NOV, '2026-11-15').find((g) => g.name === 'Trips')).toMatchObject({ saved: u(22000), pace: u(6000), status: 'on', eta: '2027-01' })
  })

  it('does not count the current month before anything was given to it', () => {
    target('Trips', { kind: 'goal', amount: u(30000) })
    give(SEP, 'Trips', 3000)
    give(OCT, 'Trips', 3000)
    spend('2026-11-02', 'Living', 100)
    expect(goals(ix(), NOV, '2026-11-15')[0].pace).toBe(u(3000))
  })
})
