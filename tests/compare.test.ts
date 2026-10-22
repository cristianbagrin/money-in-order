import { beforeEach, describe, expect, it } from 'vitest'
import { goalLine, goals, incomeBySource, roundPlan, spending, standouts, usualMonths } from '../src/lib/compare'
import * as S from '../src/lib/store'
import { emptyDB, RTA, type Category, type Target } from '../src/lib/types'

const JUL = '2026-07'
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
function earn(date: string, major: number, src?: string) {
  S.addTxn({ date, cat: RTA, amt: u(major), cur: 'TWD', src })
}
function give(month: string, name: string, major: number) {
  S.setAssigned(month, cat(name).id, u(major))
}
function target(name: string, t: Target) {
  S.saveCategory({ ...cat(name), target: t })
}
const ix = () => S.getIndex()
const texts = (month: string, today: string) => standouts(ix(), spending(ix(), month, today)).map((n) => n.text)

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
    expect(roundPlan(0)).toBe(0)
  })

  it('compares with up to three months before, from the first month with data', () => {
    expect(usualMonths(ix(), NOV)).toEqual([])
    spend('2026-07-03', 'Living', 100)
    expect(usualMonths(ix(), NOV)).toEqual([AUG, SEP, OCT])
    expect(usualMonths(ix(), SEP)).toEqual([JUL, AUG])
    expect(usualMonths(ix(), JUL)).toEqual([])
  })
})

describe('where it went', () => {
  it('ranks a finished month by spending, each against the average of the three months before', () => {
    spend('2026-08-05', 'Living', 10000)
    spend('2026-09-05', 'Living', 14000)
    spend('2026-10-05', 'Living', 12000)
    spend('2026-08-06', 'Phone', 600)
    spend('2026-09-06', 'Phone', 600)
    spend('2026-10-06', 'Phone', 600)
    spend('2026-11-05', 'Living', 9000)
    spend('2026-11-06', 'Purchases', 3000)
    spend('2026-11-07', 'Future me', 5000) // kept, not spent
    const s = spending(ix(), NOV, '2026-12-02')
    expect(s.running).toBe(false)
    expect(s.months).toEqual([AUG, SEP, OCT])
    expect(s.spent).toBe(u(12000))
    expect(s.usual).toBe(u(12600))
    expect(s.cats.map((c) => [c.name, c.spent / 100, c.usual === null ? null : c.usual / 100])).toEqual([
      ['Living', 9000, 12000],
      ['Purchases', 3000, 0],
      // nothing this month, but it usually takes a share
      ['Phone', 0, 600],
    ])
  })

  it('has no usual in the first month', () => {
    give(OCT, 'Living', 15000)
    spend('2026-10-05', 'Living', 2000)
    const s = spending(ix(), OCT, '2026-10-15')
    expect(s).toMatchObject({ running: true, day: 15, spent: u(2000), usual: null, planned: u(15000) })
    expect(s.cats[0].usual).toBeNull()
  })

  it('compares a running month with the same point of the months before', () => {
    spend('2026-09-05', 'Living', 1000)
    spend('2026-09-25', 'Living', 9000)
    spend('2026-10-05', 'Living', 2000)
    spend('2026-10-20', 'Living', 9000)
    spend('2026-11-04', 'Living', 1500)
    spend('2026-11-20', 'Living', 500) // logged ahead: not "so far"
    const s = spending(ix(), NOV, '2026-11-15')
    expect(s.spent).toBe(u(1500))
    expect(s.usual).toBe(u(1500)) // 1,000 and 2,000 by the middle of the month
  })
})

describe('standouts', () => {
  it('names a category that keeps going over, with what it really costs', () => {
    for (const m of [AUG, SEP, OCT]) {
      earn(`${m}-01`, 60000)
      give(m, 'Living', 15000)
      spend(`${m}-10`, 'Living', 17200)
    }
    expect(texts(OCT, '2026-11-10')[0]).toBe('Living went over 3 months in a row; it costs about NT$17,000 a month, not NT$15,000.')
    // November, still going: the run ends in October until November goes over too
    give(NOV, 'Living', 15000)
    spend('2026-11-03', 'Living', 1000)
    expect(texts(NOV, '2026-11-10')[0]).toBe('Living went over 3 months in a row; it costs about NT$17,000 a month, not NT$15,000.')
    // once November plans for what it costs there is nothing to say
    give(NOV, 'Living', 17500)
    expect(texts(NOV, '2026-11-10').some((t) => t.includes('went over'))).toBe(false)
  })

  it('names the biggest move against the usual, once', () => {
    for (const m of [AUG, SEP, OCT, NOV]) {
      give(m, 'Living', 11000)
      give(m, 'Purchases', 1000)
    }
    for (const m of [AUG, SEP, OCT]) {
      spend(`${m}-05`, 'Living', 10000)
      spend(`${m}-06`, 'Purchases', 1000)
    }
    spend('2026-11-05', 'Living', 10500)
    spend('2026-11-06', 'Purchases', 5000)
    expect(texts(NOV, '2026-12-02')).toEqual(['Purchases was 5 times its usual, NT$5,000.'])
    expect(standouts(ix(), spending(ix(), NOV, '2026-12-02'))[0].tone).toBe('bad') // past its plan
  })

  it('says when a category came in well below usual', () => {
    for (const m of [AUG, SEP, OCT, NOV]) give(m, 'Living', 10000)
    for (const m of [AUG, SEP, OCT]) spend(`${m}-05`, 'Living', 10000)
    spend('2026-11-05', 'Living', 6000)
    expect(standouts(ix(), spending(ix(), NOV, '2026-12-02'))).toMatchObject([{ tone: 'good', text: 'Living was NT$4,000 below usual.' }])
  })

  it('stays quiet about small moves', () => {
    for (const m of [AUG, SEP, OCT, NOV]) give(m, 'Living', 12000)
    for (const m of [AUG, SEP, OCT]) spend(`${m}-05`, 'Living', 10000)
    spend('2026-11-05', 'Living', 11000)
    expect(texts(NOV, '2026-12-02')).toEqual([])
  })
})

describe('income by source', () => {
  it('is empty without sources', () => {
    earn('2026-10-01', 1000)
    expect(incomeBySource(ix(), OCT)).toEqual([])
  })

  it('sums each source against its usual month, the rest as Other', () => {
    const job = S.addSource('Salary')
    const side = S.addSource('Clients')
    S.addSource('Unused')
    for (const m of [AUG, SEP]) earn(`${m}-01`, 50000, job.id)
    earn('2026-09-15', 4000, side.id)
    earn('2026-10-01', 50000, job.id)
    earn('2026-10-12', 10000, side.id)
    earn('2026-10-13', 300)
    S.addTxn({ date: '2026-10-14', cat: RTA, amt: u(999), cur: 'TWD', kind: 'adj' }) // a correction is not income
    expect(incomeBySource(ix(), OCT)).toEqual([
      { id: job.id, name: 'Salary', amount: u(50000), usual: u(50000) },
      { id: side.id, name: 'Clients', amount: u(10000), usual: u(2000) },
      { id: null, name: 'Other', amount: u(300), usual: 0 },
    ])
  })
})

describe('goals', () => {
  it('shows progress and when a goal gets there; buffers are not goals', () => {
    target('Trips', { kind: 'goal', amount: u(30000), by: '2027-01' })
    target('Emergency', { kind: 'refill', amount: u(10000) })
    target('Other', { kind: 'goal', amount: u(5000) })
    for (const m of [AUG, SEP, OCT]) give(m, 'Trips', 4000)
    give(AUG, 'Emergency', 12000)
    give(AUG, 'Other', 1000)
    const gs = goals(ix(), OCT, '2026-10-15')
    expect(gs.map((g) => g.name)).toEqual(['Trips', 'Other'])
    const trips = gs.find((g) => g.name === 'Trips')!
    expect(trips).toMatchObject({ saved: u(12000), pace: u(4000), eta: '2027-03', needed: u(6000), status: 'behind' })
    expect(goalLine(trips, 'TWD', OCT)).toBe('NT$6,000 a month to make Jan 2027')
    // 1,000 given in August, nothing in September; October, still going, counts once something is given to it
    const other = gs.find((g) => g.name === 'Other')!
    expect(other).toMatchObject({ status: 'open', pace: u(500), eta: '2027-06' })
    expect(goalLine(other, 'TWD', OCT)).toBe('Jun 2027 at this pace')

    give(NOV, 'Trips', 10000)
    expect(goals(ix(), NOV, '2026-11-15').find((g) => g.name === 'Trips')).toMatchObject({ saved: u(22000), pace: u(6000), status: 'on', eta: '2027-01' })
    give(NOV, 'Trips', 18000)
    expect(goalLine(goals(ix(), NOV, '2026-11-15')[0], 'TWD', NOV)).toBe('Reached')
  })

  it('does not count the current month before anything was given to it', () => {
    target('Trips', { kind: 'goal', amount: u(30000) })
    give(SEP, 'Trips', 3000)
    give(OCT, 'Trips', 3000)
    spend('2026-11-02', 'Living', 100)
    expect(goals(ix(), NOV, '2026-11-15')[0].pace).toBe(u(3000))
  })
})
