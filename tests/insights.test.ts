import { beforeEach, describe, expect, it } from 'vitest'
import { monthView } from '../src/lib/budget'
import { burn, categoryTrends, insights, monthSeries, weeks } from '../src/lib/insights'
import * as S from '../src/lib/store'
import { emptyDB, RTA, type Category } from '../src/lib/types'

const JUL = '2026-07'
const AUG = '2026-08'
const SEP = '2026-09'
const OCT = '2026-10'
const NOV = '2026-11'
const TODAY = '2026-10-15' // a Thursday

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
const ix = () => S.getIndex()

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: { EUR: 36.16 }, savingsTarget: 0.2 })
  S.seedCategories()
})

describe('monthSeries', () => {
  it('is all zeros with no data', () => {
    expect(monthSeries(ix(), [OCT], OCT)).toEqual([{ month: OCT, income: 0, spent: 0, saved: 0, savingsRate: null, planned: 0 }])
  })

  it('reports income, spending, savings and the plan per month', () => {
    earn('2026-09-01', 60000)
    give(SEP, 'Living', 15000)
    give(SEP, 'Purchases', 5000)
    give(SEP, 'Future me', 12000)
    spend('2026-09-03', 'Living', 16000) // 1,000 over
    spend('2026-09-04', 'Purchases', 2000)
    spend('2026-09-05', 'Trips', 3000) // nothing assigned: carries -3,000
    spend('2026-09-06', 'Future me', 12000) // investing is not spending
    give(OCT, 'Living', 15000)
    give(OCT, 'Purchases', 5000)
    give(OCT, 'Trips', 1000)
    give(NOV, 'Living', 15000)

    const [sep, oct, nov] = monthSeries(ix(), [SEP, OCT, NOV], OCT)
    expect(sep).toEqual({ month: SEP, income: u(60000), spent: u(21000), saved: u(12000), savingsRate: 0.2, planned: u(20000) })
    // Living −1,000 + 15,000; Purchases 3,000 + 5,000; Trips −3,000 + 1,000 clamps to 0
    expect(oct.planned).toBe(u(14000 + 8000))
    expect(oct.spent).toBe(0)
    expect(oct.savingsRate).toBeNull()
    // November: Living carries 14,000 and gets 15,000 more, Purchases carries 8,000
    expect(nov.planned).toBe(u(29000 + 8000))
  })
})

describe('burn', () => {
  beforeEach(() => {
    give(SEP, 'Living', 10000)
    give(SEP, 'Purchases', 5000)
    spend('2026-09-03', 'Living', 1000)
    spend('2026-09-10', 'Purchases', 4000)
    S.addTxn({ date: '2026-09-12', cat: cat('Purchases').id, amt: u(500), cur: 'TWD' }) // a refund
    spend('2026-09-20', 'Future me', 9000) // savings: left out
    earn('2026-09-01', 50000) // income: left out
    give(OCT, 'Living', 12000)
    spend('2026-10-02', 'Living', 700)
    spend('2026-10-15', 'Living', 300)
    spend('2026-10-20', 'Living', 5000) // logged ahead of time
  })

  it('draws a finished month in full', () => {
    const b = burn(ix(), SEP, TODAY)
    expect(b.days).toBe(30)
    expect(b.today).toBeNull()
    expect(b.actual).toHaveLength(30)
    expect(b.actual[1]).toBe(0)
    expect(b.actual[2]).toBe(u(1000))
    expect(b.actual[9]).toBe(u(5000))
    expect(b.actual[11]).toBe(u(4500))
    expect(b.actual[29]).toBe(u(4500))
    expect(b.actual[29]).toBe(monthView(ix(), SEP, OCT).spent)
    expect(b.plan).toBe(u(15000))
    expect(b.previous).toEqual([]) // August had nothing
  })

  it('stops the current month at today and stretches last month to fit', () => {
    const b = burn(ix(), OCT, TODAY)
    expect(b.days).toBe(31)
    expect(b.today).toBe(15)
    expect(b.actual[14]).toBe(u(1000))
    expect(b.actual[15]).toBeNull()
    expect(b.actual.filter((v) => v !== null)).toHaveLength(15)
    // Living carries 9,000 and gets 12,000; Purchases carries 1,500
    expect(b.plan).toBe(u(21000 + 1500))
    expect(b.plan).toBe(monthSeries(ix(), [OCT], OCT)[0].planned)
    expect(b.previous).toHaveLength(31)
    expect(b.previous[30]).toBe(u(4500))
    // September day 3 lands at October index ~2.1
    expect(b.previous[0]).toBe(0)
    expect(b.previous[3]).toBe(u(1000))
    for (let i = 1; i < 9; i++) expect(b.previous[i]).toBeGreaterThanOrEqual(b.previous[i - 1])
  })

  it('has no actual line for a month that has not started', () => {
    const b = burn(ix(), NOV, TODAY)
    expect(b.days).toBe(30)
    expect(b.today).toBe(0)
    expect(b.actual.every((v) => v === null)).toBe(true)
    expect(b.previous[29]).toBe(u(6000)) // all of October, the future entry included
  })

  it('resamples proportionally between months of different length', () => {
    S.replaceDB(emptyDB())
    S.seedCategories()
    for (let d = 1; d <= 31; d++) spend(`2027-01-${String(d).padStart(2, '0')}`, 'Living', 100)
    const b = burn(ix(), '2027-02', '2027-02-10')
    expect(b.days).toBe(28)
    expect(b.previous).toHaveLength(28)
    expect(b.previous[0]).toBe(Math.round((u(100) * 31) / 28))
    expect(b.previous[13]).toBe(Math.round((u(100) * 14 * 31) / 28))
    expect(b.previous[27]).toBe(u(3100))
  })
})

describe('categoryTrends', () => {
  it('is empty with no data', () => {
    expect(categoryTrends(ix(), OCT, OCT)).toEqual([])
  })

  it('tracks each spending category across months', () => {
    give(JUL, 'Living', 10000)
    spend('2026-07-05', 'Living', 9000)
    spend('2026-08-05', 'Living', 11000) // nothing assigned in August: over
    spend('2026-08-06', 'Purchases', 2000) // over
    give(SEP, 'Purchases', 1000)
    spend('2026-09-07', 'Purchases', 4000) // over again
    give(OCT, 'Living', 10000)
    spend('2026-10-07', 'Living', 6000)
    give(OCT, 'Phone', 600) // planned, nothing spent yet
    spend('2026-10-08', 'Future me', 5000) // savings
    const trips = cat('Trips')
    spend('2026-09-09', 'Trips', 800)
    S.saveCategory({ ...trips, archived: 1 })

    const t = categoryTrends(ix(), OCT, OCT, 6)
    expect(t.map((x) => x.name)).toEqual(['Living', 'Phone', 'Purchases'])
    const living = t[0]
    // Data starts in July, so the window is Jul..Oct
    expect(living.series).toEqual([u(9000), u(11000), 0, u(6000)])
    expect(living.thisMonth).toBe(u(6000))
    expect(living.average).toBe(u(10000)) // July and August; September had no activity
    // carried: 1,000 − 11,000 = −10,000, then +10,000 assigned
    expect(living.planned).toBe(0)
    expect(living.overMonths).toBe(1) // August only; October's debt was carried in, not new spending
    const purchases = t.find((x) => x.name === 'Purchases')!
    expect(purchases.overMonths).toBe(2)
    expect(purchases.average).toBe(u(3000))
    const phone = t.find((x) => x.name === 'Phone')!
    expect(phone.series).toEqual([0, 0, 0, 0])
    expect(phone.planned).toBe(u(600))
  })

  it('keeps the window to n months and starts at the first month with data', () => {
    for (const m of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) spend(`${m}-10`, 'Living', 100)
    expect(categoryTrends(ix(), '2026-06', '2026-06', 3)[0].series).toEqual([u(100), u(100), u(100)])
    expect(categoryTrends(ix(), '2026-02', '2026-06', 6)[0].series).toEqual([u(100), u(100)])
  })
})

describe('weeks', () => {
  it('returns just the current week with no data', () => {
    expect(weeks(ix(), TODAY)).toEqual([{ start: '2026-10-12', spent: 0 }])
  })

  it('sums Monday-to-Sunday weeks up to today', () => {
    spend('2026-08-01', 'Living', 1)
    spend('2026-10-11', 'Living', 50) // Sunday: last week
    spend('2026-10-12', 'Living', 100) // Monday
    spend('2026-10-15', 'Purchases', 200)
    spend('2026-10-16', 'Living', 999) // tomorrow
    spend('2026-10-13', 'Future me', 5000) // savings
    earn('2026-10-14', 40000)
    const w = weeks(ix(), TODAY, 8)
    expect(w).toHaveLength(8)
    expect(w[0].start).toBe('2026-08-24')
    expect(w[7]).toEqual({ start: '2026-10-12', spent: u(300) })
    expect(w[6]).toEqual({ start: '2026-10-05', spent: u(50) })
    for (let i = 1; i < 8; i++) expect(new Date(w[i].start).getTime() - new Date(w[i - 1].start).getTime()).toBe(7 * 86400000)
  })

  it('drops weeks before the first transaction and spans month ends', () => {
    spend('2026-09-30', 'Living', 30)
    spend('2026-10-02', 'Living', 20)
    const w = weeks(ix(), TODAY, 8)
    expect(w.map((x) => x.start)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12'])
    expect(w[0].spent).toBe(u(50))
  })

  it('treats Sunday as the end of the week', () => {
    spend('2026-10-12', 'Living', 10)
    spend('2026-10-18', 'Living', 20)
    const w = weeks(ix(), '2026-10-18', 2)
    expect(w[w.length - 1]).toEqual({ start: '2026-10-12', spent: u(30) })
  })
})

describe('insights', () => {
  const check = (notes: { tone: string; text: string }[]) => {
    expect(notes.length).toBeLessThanOrEqual(4)
    for (const n of notes) {
      expect(n.text.length).toBeLessThanOrEqual(90)
      expect(n.text).not.toMatch(/!/)
      expect(n.text).toMatch(/\.$/)
    }
    return notes.map((n) => n.text)
  }

  it('says nothing without data, before the data starts, or for future months', () => {
    expect(insights(ix(), OCT, TODAY)).toEqual([])
    spend('2026-09-03', 'Living', 100)
    expect(insights(ix(), AUG, TODAY)).toEqual([])
    expect(insights(ix(), NOV, TODAY)).toEqual([])
  })

  it('warns when daily spending is running ahead of plan', () => {
    give(OCT, 'Living', 15000)
    spend('2026-10-03', 'Living', 6000)
    spend('2026-10-12', 'Living', 6000)
    // 12,000 in 15 days -> 24,800 by the 31st, 9,800 over
    const notes = insights(ix(), OCT, TODAY)
    expect(check(notes)).toContain('At this pace you’ll go NT$9,800 over plan this month.')
    expect(notes.find((n) => n.text.startsWith('At this pace'))!.tone).toBe('bad')
  })

  it('says how far under plan daily spending will finish', () => {
    give(OCT, 'Living', 15000)
    give(OCT, 'Phone', 600)
    spend('2026-10-02', 'Phone', 600)
    spend('2026-10-03', 'Living', 5000)
    // 5,000 in 15 days -> 10,333; 4,667 under -> roughly 4,700
    const notes = insights(ix(), OCT, TODAY)
    const pace = notes.find((n) => n.text.startsWith('At this pace'))!
    expect(pace).toEqual({ tone: 'good', text: 'At this pace you’ll end the month NT$4,700 under plan.' })
  })

  it('waits a week before projecting', () => {
    give(OCT, 'Living', 15000)
    spend('2026-10-02', 'Living', 9000)
    expect(insights(ix(), OCT, '2026-10-05').some((n) => n.text.startsWith('At this pace'))).toBe(false)
  })

  it('puts categories that are over plan first, with their streak', () => {
    give(SEP, 'Purchases', 1000)
    spend('2026-09-05', 'Purchases', 1500)
    give(OCT, 'Purchases', 1500) // covers September's 500 and leaves 1,000
    spend('2026-10-05', 'Purchases', 2200)
    const notes = insights(ix(), OCT, TODAY)
    expect(notes[0]).toEqual({ tone: 'bad', text: 'Purchases is NT$1,200 over plan, 2 months in a row.' })
    // not repeated as a "keeps going over" sentence
    expect(notes.filter((n) => n.text.includes('Purchases'))).toHaveLength(1)
  })

  it('names several overspent categories together', () => {
    spend('2026-10-05', 'Purchases', 300)
    spend('2026-10-05', 'Trips', 200)
    spend('2026-10-05', 'Other', 100)
    expect(insights(ix(), OCT, TODAY)[0].text).toBe('3 categories are NT$600 over plan, most in Purchases.')
  })

  it('points out a category that keeps going over', () => {
    spend('2026-08-05', 'Trips', 500)
    give(SEP, 'Trips', 500) // covers August
    spend('2026-09-05', 'Trips', 800) // over again
    give(OCT, 'Trips', 2000)
    spend('2026-10-05', 'Trips', 100)
    expect(check(insights(ix(), OCT, TODAY))).toContain('Trips went over plan in 2 of the last 3 months.')
    expect(check(insights(ix(), SEP, TODAY))).toContain('Trips went NT$800 over plan, 2 months in a row.')
  })

  it('compares the savings rate with the target', () => {
    earn('2026-09-01', 60000)
    give(SEP, 'Future me', 18000)
    spend('2026-09-03', 'Living', 1000)
    let notes = insights(ix(), SEP, TODAY)
    expect(notes[0]).toEqual({ tone: 'good', text: 'You saved 30% of your income. Your target is 20%.' })
    give(SEP, 'Future me', 6000)
    notes = insights(ix(), SEP, TODAY)
    expect(notes[0]).toEqual({ tone: 'bad', text: 'You saved 10% of your income. Your target is 20%.' })
  })

  it('shows what is left to save in the current month', () => {
    earn('2026-10-01', 60000)
    give(OCT, 'Future me', 8000)
    spend('2026-10-03', 'Living', 1000)
    expect(check(insights(ix(), OCT, TODAY))).toContain('Saving 20% of this month’s income means NT$12,000; NT$4,000 to go.')
    give(OCT, 'Future me', 15000)
    expect(insights(ix(), OCT, TODAY)).toContainEqual({ tone: 'good', text: 'You’ve saved 25% of this month’s income. Your target is 20%.' })
  })

  it('reads a past month against its plan, and investing is not spending', () => {
    earn('2026-09-01', 50000)
    give(SEP, 'Living', 15000)
    give(SEP, 'Future me', 10000)
    spend('2026-09-03', 'Living', 12000)
    spend('2026-09-10', 'Future me', 10000)
    const texts = check(insights(ix(), SEP, TODAY))
    expect(texts).toContain('You spent NT$12,000, NT$3,000 less than planned.')
    expect(texts).toContain('You saved 20% of your income. Your target is 20%.')
  })

  it('finds the category that moved most against its average', () => {
    for (const m of [JUL, AUG]) {
      give(m, 'Living', 20000)
      spend(`${m}-05`, 'Living', 10000)
      spend(`${m}-06`, 'Purchases', 1000)
      give(m, 'Purchases', 1000)
    }
    give(SEP, 'Living', 20000)
    give(SEP, 'Purchases', 1000)
    spend('2026-09-05', 'Living', 15000)
    spend('2026-09-06', 'Purchases', 1000)
    expect(check(insights(ix(), SEP, TODAY))).toContain('Living was 50% higher than your 2-month average.')
  })

  it('compares the current month by the same point in earlier months', () => {
    give(SEP, 'Living', 20000)
    spend('2026-09-05', 'Living', 4000)
    spend('2026-09-25', 'Living', 6000)
    give(OCT, 'Living', 10000)
    spend('2026-10-05', 'Living', 1000)
    // by Oct 15 September had spent 4,000 (by its day 15); October 1,000
    expect(check(insights(ix(), OCT, TODAY))).toContain('Living is 75% lower than at this point in September.')
  })

  it('compares this week with the same days of last week', () => {
    spend('2026-09-01', 'Living', 10)
    spend('2026-10-05', 'Living', 2000) // last Monday
    spend('2026-10-08', 'Living', 1000) // last Thursday
    spend('2026-10-10', 'Living', 9000) // last Saturday: not yet comparable
    spend('2026-10-13', 'Living', 2400)
    const texts = check(insights(ix(), OCT, TODAY))
    expect(texts).toContain('This week you’ve spent NT$2,400, NT$600 less than by this day last week.')
    const sunday = check(insights(ix(), OCT, '2026-10-18'))
    expect(sunday).toContain('This week you spent NT$2,400, NT$9,600 less than last week.')
  })

  it('does not call a lumpy category low before the month is over', () => {
    for (const m of [JUL, AUG, SEP, OCT]) give(m, 'Purchases', 4000)
    for (const m of [JUL, AUG, SEP]) spend(`${m}-05`, 'Purchases', 4000)
    spend('2026-10-03', 'Purchases', 500)
    expect(insights(ix(), OCT, TODAY).some((n) => n.text.startsWith('Purchases'))).toBe(false)
    // once the month is over it is a fair comparison
    expect(insights(ix(), OCT, '2026-11-02').some((n) => n.text === 'Purchases was 88% lower than your 3-month average.')).toBe(true)
  })

  it('skips the week sentence when nothing was spent this week', () => {
    spend('2026-10-06', 'Living', 1000)
    expect(insights(ix(), OCT, TODAY).some((n) => n.text.startsWith('This week'))).toBe(false)
  })

  it('ignores money moved into savings when reading spending', () => {
    give(SEP, 'Living', 10000)
    spend('2026-09-04', 'Living', 9000)
    spend('2026-09-05', 'Future me', 50000)
    const texts = insights(ix(), SEP, TODAY).map((n) => n.text)
    expect(texts).toContain('You spent NT$9,000, NT$1,000 less than planned.')
    expect(texts.join(' ')).not.toMatch(/Future me/)
  })

  it('stays within four sentences on a busy month', () => {
    earn('2026-09-01', 60000)
    earn('2026-10-01', 60000)
    for (const m of [JUL, AUG, SEP]) {
      give(m, 'Living', 15000)
      give(m, 'Trips', 1000)
      spend(`${m}-04`, 'Living', 14000)
      spend(`${m}-05`, 'Trips', 2000)
    }
    give(OCT, 'Living', 15000)
    give(OCT, 'Purchases', 1000)
    spend('2026-10-03', 'Living', 14000)
    spend('2026-10-06', 'Purchases', 5000)
    spend('2026-10-13', 'Living', 1000)
    const notes = insights(ix(), OCT, TODAY)
    expect(notes).toHaveLength(4)
    check(notes)
    expect(notes[0].tone).toBe('bad')
  })

  it('formats in the budget currency', () => {
    S.updateSettings({ base: 'EUR' })
    S.addTxn({ date: '2026-09-01', cat: RTA, amt: 300000, cur: 'EUR' })
    S.setAssigned(SEP, cat('Future me').id, 90050)
    S.addTxn({ date: '2026-09-02', cat: cat('Living').id, amt: -1000, cur: 'EUR' })
    S.setAssigned(SEP, cat('Living').id, 70000)
    const texts = insights(ix(), SEP, TODAY).map((n) => n.text)
    expect(texts).toContain('You saved 30% of your income. Your target is 20%.')
    expect(texts).toContain('You spent €10, €690 less than planned.')
  })
})
