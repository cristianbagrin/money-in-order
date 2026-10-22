import { beforeEach, describe, expect, it } from 'vitest'
import { monthView } from '../src/lib/budget'
import { calcPress, isSum } from '../src/lib/calc'
import { catsWithHistory, expectedIncome, extraOf, fillPlan, forecast, savingsGoal, suggestions } from '../src/lib/plan'
import * as S from '../src/lib/store'
import { emptyDB, RTA, type Category } from '../src/lib/types'

const OCT = '2026-10'
const NOV = '2026-11'

function cat(name: string): Category {
  return Object.values(S.getDB().cats).find((c) => c.name === name)!
}
const income = (date: string, amt: number) => S.addTxn({ date, cat: RTA, amt, cur: 'TWD' })
const spend = (date: string, name: string, amt: number) => S.addTxn({ date, cat: cat(name).id, amt: -amt, cur: 'TWD' })
const want = (month: string, name: string) => suggestions(S.getIndex(), month, OCT).find((s) => s.cat === cat(name).id)!

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: {}, savingsTarget: 0.2 })
  S.seedCategories()
  // Keep the example small: one saving category.
  for (const n of ['Emergency', 'NAWA (hold)']) S.saveCategory({ ...cat(n), saving: undefined, archived: 1 })
})

/** Three finished months of income and spending before October. */
function history() {
  for (const [m, inc] of [
    ['2026-07', 6000000],
    ['2026-08', 5000000],
    ['2026-09', 7000000],
  ] as const) {
    income(`${m}-01`, inc)
    spend(`${m}-10`, 'Living', 1500000)
    S.setAssigned(m, cat('Living').id, 1500000)
    S.setAssigned(m, cat('Future me').id, 1000000)
  }
  spend('2026-09-15', 'Purchases', 300000)
}

describe('expected income', () => {
  it('is the median of the last 3 finished months, 0 without history', () => {
    expect(expectedIncome(S.getIndex(), OCT)).toBe(0)
    history()
    expect(expectedIncome(S.getIndex(), OCT)).toBe(6000000)
  })
  it('only counts months the budget existed in', () => {
    income('2026-09-01', 4000000)
    expect(expectedIncome(S.getIndex(), OCT)).toBe(4000000)
  })
})

describe('suggestions', () => {
  it('targets first, overspending cleared, usual costs less what is already there', () => {
    history()
    S.saveCategory({ ...cat('Phone'), target: { kind: 'topup', amount: 60000 } })
    expect(want(OCT, 'Phone')).toMatchObject({ base: 60000, want: 60000 })
    expect(want(OCT, 'Living').want).toBe(1500000)
    // Living carried 0 (assigned = spent); with 5,000 left from September it asks for 10,000.
    S.setAssigned('2026-09', cat('Living').id, 2000000)
    expect(want(OCT, 'Living').want).toBe(1000000)
    // Overspent: the debt comes first and on top of the usual.
    S.setAssigned('2026-09', cat('Living').id, 1000000)
    expect(want(OCT, 'Living')).toMatchObject({ base: 500000, want: 2000000 })
  })

  it('savings categories get the savings target, shared by how they were funded lately', () => {
    history()
    S.saveCategory({ ...cat('Emergency'), archived: undefined, saving: true })
    // 20% of 60,000 = 12,000; Future me had all of the recent savings.
    expect(savingsGoal(S.getIndex(), OCT, OCT)).toBe(1200000)
    expect(want(OCT, 'Future me').want).toBe(1200000)
    expect(want(OCT, 'Emergency').want).toBe(0)
    // Money already saved this month counts toward it.
    S.setAssigned(OCT, cat('Emergency').id, 500000)
    expect(want(OCT, 'Future me').want).toBe(700000)
  })

  it('a coming month stands on its own: targets, savings and usual costs', () => {
    history()
    S.saveCategory({ ...cat('Phone'), target: { kind: 'topup', amount: 60000 } })
    S.setAssigned(OCT, cat('Living').id, 9000000) // lots left in October doesn't make January cheaper
    const jan = '2027-01'
    expect(want(jan, 'Living').want).toBe(1500000)
    expect(want(jan, 'Phone').want).toBe(60000)
    expect(want(jan, 'Future me').want).toBe(1200000)
  })
})

describe('fill', () => {
  it('assigns by priority as far as the money goes', () => {
    history()
    S.saveCategory({ ...cat('Phone'), target: { kind: 'topup', amount: 60000 } })
    const list = suggestions(S.getIndex(), OCT, OCT)
    const total = list.reduce((s, x) => s + extraOf(x), 0)
    // Phone 600, Future me 12,000, Living 15,000, Purchases 3,000 overspent in September + 3,000 usual
    expect(total).toBe(60000 + 1200000 + 1500000 + 600000)
    // 13,000: the target and the overspending, then savings get the rest; Living waits.
    const fill = fillPlan(list, 1300000)
    expect(fill).toEqual([
      { cat: cat('Phone').id, amount: 60000, add: 60000 },
      { cat: cat('Purchases').id, amount: 300000, add: 300000 },
      { cat: cat('Future me').id, amount: 940000, add: 940000 },
    ])
    expect(fill.reduce((s, f) => s + f.add, 0)).toBe(1300000)
  })

  it('never takes money away and fills nothing without money', () => {
    history()
    S.setAssigned(OCT, cat('Living').id, 9000000)
    const list = suggestions(S.getIndex(), OCT, OCT)
    expect(fillPlan(list, 0)).toEqual([])
    expect(fillPlan(list, 10000000).find((f) => f.cat === cat('Living').id)).toBeUndefined()
  })
})

describe('forecast', () => {
  it('shows where the money runs out', () => {
    history()
    const ix = S.getIndex()
    const rta = monthView(ix, OCT, OCT).readyToAssign
    const f = forecast(ix, OCT, 6)
    expect(f.income).toBe(6000000)
    expect(f.months).toHaveLength(6)
    // A month needs 12,000 + 15,000 + 3,000 = 30,000 and brings 60,000: never runs out.
    expect(f.typical).toBe(3000000)
    expect(f.runsOut).toBe(null)
    // October also clears September's overspending, and this month's income is still to come.
    expect(f.months[0].left).toBe(rta + 6000000 - 3300000)
    expect(f.months[1].left).toBe(f.months[0].left + 6000000 - 3000000)
  })

  it('counts money already given to coming months as planned', () => {
    history()
    const ix0 = S.getIndex()
    const before = forecast(ix0, OCT, 3)
    S.setAssigned(NOV, cat('Living').id, 1500000)
    const after = forecast(S.getIndex(), OCT, 3)
    expect(after.months[1].need).toBe(before.months[1].need - 1500000)
    expect(after.months[2].left).toBe(before.months[2].left) // the same money, planned earlier
    expect(after.ahead).toBeGreaterThan(0)
  })

  it('counts the whole months the money in hand already pays for, without income', () => {
    history()
    const f = forecast(S.getIndex(), OCT, 6)
    // 105,000 to assign; October still needs 33,000, leaving 72,000: two 30,000 months.
    expect(f.ahead).toBe(2)
    expect(f.until).toBe('2026-12')
    expect(f.months.map((m) => m.covered)).toEqual([true, true, true, false, false, false])
    // Money given to November already is in hand all the same.
    S.setAssigned(NOV, cat('Living').id, 1500000)
    expect(forecast(S.getIndex(), OCT, 6).ahead).toBe(2)
    // Spending it shortens the reach.
    spend('2026-10-03', 'Purchases', 2000000) // 17,000 over what October planned for it
    expect(forecast(S.getIndex(), OCT, 6).ahead).toBe(1)
  })

  it('runs out when plans outgrow income', () => {
    income('2026-09-01', 1000000)
    S.saveCategory({ ...cat('Phone'), target: { kind: 'monthly', amount: 600000 } })
    const f = forecast(S.getIndex(), OCT, 6)
    // 10,000 now and 10,000 a month; 6,000 phone + 2,000 savings a month: covered
    expect(f.runsOut).toBe(null)
    // 17,000 a month: October is covered by what's there, November isn't.
    S.saveCategory({ ...cat('Phone'), target: { kind: 'monthly', amount: 1500000 } })
    const g = forecast(S.getIndex(), OCT, 6)
    expect(g.runsOut).toBe(NOV)
    expect(g.months[1].left).toBe(-400000)
  })
})

describe('history', () => {
  it('knows which categories were ever used', () => {
    spend('2026-10-02', 'Living', 100)
    S.setAssigned(OCT, cat('Phone').id, 100)
    const h = catsWithHistory(S.getIndex())
    expect(h.has(cat('Living').id)).toBe(true)
    expect(h.has(cat('Phone').id)).toBe(true)
    expect(h.has(cat('Trips').id)).toBe(false)
  })
})

describe('keypad at the caret', () => {
  const at = (v: string, k: string, d = 0, caret = v.length) => calcPress(v, caret, k, d)
  it('types digits and keeps separators', () => {
    expect(at('1,234', '5')).toEqual({ value: '12,345', caret: 6 })
    expect(at('0', '7')).toEqual({ value: '7', caret: 1 })
    expect(at('', '00')).toBe(null)
    expect(at('12', '00')).toEqual({ value: '1,200', caret: 5 })
  })
  it('edits in the middle', () => {
    // 1|,234 → 15,234
    expect(at('1,234', '5', 0, 1)).toEqual({ value: '15,234', caret: 2 })
    expect(at('1,234', 'back', 0, 3)).toEqual({ value: '134', caret: 1 })
  })
  it('sums: operators, never doubled', () => {
    expect(at('200', '+')).toEqual({ value: '200+', caret: 4 })
    expect(at('200+', '−')).toEqual({ value: '200−', caret: 4 })
    expect(at('', '×')).toBe(null)
    expect(at('', '−')).toEqual({ value: '−', caret: 1 })
    expect(isSum('200+15')).toBe(true)
    expect(isSum('−200')).toBe(false)
  })
  it('decimals per currency', () => {
    expect(at('12', '.', 0)).toBe(null)
    expect(at('12', '.', 2)).toEqual({ value: '12.', caret: 3 })
    expect(at('12.34', '5', 2)).toBe(null)
    expect(at('12.3', '5', 2)).toEqual({ value: '12.35', caret: 5 })
    expect(at('', '.', 2)).toEqual({ value: '0.', caret: 2 })
  })
})
