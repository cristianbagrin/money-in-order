import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { merge } from '../src/lib/merge'
import { suggestions } from '../src/lib/plan'
import { dueDate, dueIn, occurrences } from '../src/lib/repeat'
import * as S from '../src/lib/store'
import { emptyDB, live, type Category, type Repeat, type Txn } from '../src/lib/types'

const OCT = '2026-10'

function cat(name: string): Category {
  return Object.values(S.getDB().cats).find((c) => c.name === name)!
}
const spend = (date: string, name: string, amt: number, note?: string) => S.addTxn({ date, cat: cat(name).id, amt: -amt, cur: 'TWD', note })
const repeats = () => live(S.getDB().repeats)
const logged = (r: Repeat) => live(S.getDB().txns).filter((t) => t.rep === r.id).sort((a, b) => (a.date < b.date ? -1 : 1))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 22, 12))
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: {}, savingsTarget: 0 })
  S.seedCategories()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('when it comes back', () => {
  const r = (every: Repeat['every'], from: string, after = from): Repeat => ({ id: 'r', u: 0, every, from, after, cat: 'c', amt: -100, cur: 'TWD' })
  it('on its day, or the last day of a shorter month', () => {
    expect(dueDate(r('month', '2026-01-31'), '2026-02')).toBe('2026-02-28')
    expect(dueDate(r('month', '2026-01-31'), '2026-03')).toBe('2026-03-31')
    expect(dueDate(r('year', '2026-03-15'), '2027-03')).toBe('2027-03-15')
    expect(dueDate(r('year', '2026-03-15'), '2027-04')).toBeNull()
  })
  it('only after `after`, up to the day asked', () => {
    expect(occurrences(r('month', '2026-08-05', '2026-10-22'), '2027-01-05').map((o) => o.date)).toEqual(['2026-11-05', '2026-12-05', '2027-01-05'])
    expect(occurrences(r('year', '2026-08-05'), '2028-12-31').map((o) => o.id)).toEqual(['r~2027', 'r~2028'])
  })
})

describe('repeating an entry', () => {
  it('logs nothing already past, then each month on its day, once', () => {
    const t = spend('2026-10-05', 'Phone', 59900, 'Phone bill')
    S.setRepeat(t.id, 'month')
    const [r] = repeats()
    expect(r).toMatchObject({ every: 'month', from: '2026-10-05', after: '2026-10-22', amt: -59900, note: 'Phone bill' })
    expect(S.logRepeats('2026-10-22')).toEqual([])
    expect(S.logRepeats('2026-11-04')).toEqual([])
    const made = S.logRepeats('2026-12-06')
    expect(made.map((x) => x.date)).toEqual(['2026-11-05', '2026-12-05'])
    expect(made[0]).toMatchObject({ cat: cat('Phone').id, amt: -59900, base: -59900, note: 'Phone bill', rep: r.id })
    expect(S.logRepeats('2026-12-06')).toEqual([])
  })

  it('one deleted stays deleted, even when another device logs it again', () => {
    const t = spend('2026-10-05', 'Phone', 59900)
    S.setRepeat(t.id, 'month')
    vi.setSystemTime(new Date(2026, 10, 5, 9))
    const before = S.getDB()
    const [nov] = S.logRepeats('2026-11-05')
    S.deleteTxn(nov.id)
    const here = S.getDB()
    // a device that hasn't heard of the delete logs it on its own
    S.replaceDB(before)
    S.logRepeats('2026-11-05')
    const there = S.getDB()
    expect(merge(here, there).txns[nov.id].d).toBe(1)
    expect(merge(there, here).txns[nov.id].d).toBe(1)
  })

  it('stops, switches to yearly, and follows edits to its latest entry', () => {
    const t = spend('2026-10-05', 'Phone', 59900)
    S.setRepeat(t.id, 'month')
    const [r] = repeats()
    S.updateTxn(t.id, { amt: -69900 })
    expect(repeats()[0].amt).toBe(-69900)
    const [nov] = S.logRepeats('2026-11-05')
    // an older entry changing doesn't change what it logs
    S.updateTxn(t.id, { amt: -10000 })
    expect(repeats()[0].amt).toBe(-69900)
    S.updateTxn(nov.id, { note: 'New plan' })
    expect(repeats()[0].note).toBe('New plan')
    S.setRepeat(nov.id, 'year')
    expect(repeats()[0]).toMatchObject({ id: r.id, every: 'year' })
    S.setRepeat(nov.id, null)
    expect(repeats()).toEqual([])
    expect(S.logRepeats('2027-12-31')).toEqual([])
    expect(logged(r).length).toBe(2)
  })

  it('leaves a category that is archived alone', () => {
    const t = spend('2026-10-05', 'Phone', 59900)
    S.setRepeat(t.id, 'month')
    S.saveCategory({ ...cat('Phone'), archived: 1 })
    expect(S.logRepeats('2026-12-31')).toEqual([])
  })
})

describe('the plan', () => {
  it('asks for what repeats in a month, first', () => {
    const t = spend('2026-10-05', 'Phone', 59900)
    S.setRepeat(t.id, 'month')
    const ins = S.addTxn({ date: '2026-10-01', cat: cat('Trips').id, amt: -1200000, cur: 'TWD' })
    S.setRepeat(ins.id, 'year')
    const ix = S.getIndex()
    expect(dueIn(ix, '2026-11').get(cat('Phone').id)).toBe(59900)
    expect(dueIn(ix, '2026-11').has(cat('Trips').id)).toBe(false)
    expect(dueIn(ix, '2027-10').get(cat('Trips').id)).toBe(1200000)
    const want = (m: string, name: string) => suggestions(S.getIndex(), m, OCT).find((s) => s.cat === cat(name).id)!
    expect(want('2026-11', 'Phone')).toMatchObject({ base: 59900, due: 59900 })
    // this month: the bill is paid already, so what covers it
    expect(want(OCT, 'Phone').base).toBe(59900)
    S.setAssigned(OCT, cat('Phone').id, 59900)
    expect(want(OCT, 'Phone').base).toBe(59900)
    expect(want('2027-10', 'Trips').base).toBe(1200000)
  })
})

describe('older entries', () => {
  it('carry no repeat', () => {
    const t: Txn = spend('2026-10-05', 'Phone', 100)
    expect(S.repeatOf(t)).toBeNull()
  })
})
