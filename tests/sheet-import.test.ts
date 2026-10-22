import { beforeEach, describe, expect, it } from 'vitest'
import { monthView } from '../src/lib/budget'
import { importSheet, loggedIn, type SheetFile } from '../src/lib/sheetImport'
import * as S from '../src/lib/store'
import { emptyDB, live, RTA } from '../src/lib/types'

// Made-up numbers only: the repo is public.
const FILE: SheetFile = {
  kind: 'money-in-order/sheet-import',
  version: 1,
  currency: 'TWD',
  months: [
    {
      month: '2026-08',
      start: 100000,
      plan: { Living: 50000, 'BJJ/gym': 10000 },
      txns: [
        { date: '2026-08-02', cat: 'Living', amt: -70000, cur: 'TWD', base: -70000, note: 'Groceries' },
        { date: '2026-08-03', cat: 'BJJ/gym', amt: -10000, cur: 'TWD', base: -10000 },
        { date: '2026-08-01', cat: 'Income', amt: 1000, cur: 'EUR', base: 36000 },
      ],
    },
    {
      month: '2026-09',
      start: 30000,
      plan: { Living: 40000 },
      txns: [{ date: '2026-09-04', cat: 'Living', amt: -10000, cur: 'TWD', base: -10000 }],
    },
  ],
}

const id = (name: string) => live(S.getDB().cats).find((c) => c.name === name)!.id
const money = () => live(S.getDB().txns).reduce((s, t) => s + t.base, 0)
const avail = (m: string, name: string) => monthView(S.getIndex(), m, '2026-10').byId.get(id(name))!.available

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: { EUR: 36 } })
  S.seedCategories()
  // Started using the app in October: an opening balance and a plan.
  S.addTxn({ date: '2026-10-02', cat: RTA, amt: 500000, cur: 'TWD', kind: 'start', note: 'Starting balance' })
  S.addTxn({ date: '2026-10-03', cat: id('Living'), amt: -2000, cur: 'TWD' })
  S.setAssigned('2026-10', id('Living'), 60000)
})

describe('importing months from a spreadsheet', () => {
  it('each month starts fresh like the sheet, and money on hand today stays the same', () => {
    const had = money()
    const n = S.undoable('Imported', () => importSheet(FILE, ['2026-08', '2026-09'], []))
    expect(n).toBe(4)
    expect(money()).toBe(had)
    // August: planned minus spent.
    expect(avail('2026-08', 'Living')).toBe(-20000)
    expect(avail('2026-08', 'BJJ / gym')).toBe(0)
    // September starts at zero again: its plan covers August's overspending.
    expect(avail('2026-09', 'Living')).toBe(30000)
    // October, already planned here, starts fresh too and keeps its own plan.
    expect(avail('2026-10', 'Living')).toBe(60000 - 2000)
    // One opening balance (August's); October's count became a correction.
    const kinds = live(S.getDB().txns).filter((t) => t.kind).map((t) => [t.date, t.kind])
    expect(kinds).toContainEqual(['2026-08-01', 'start'])
    expect(kinds).toContainEqual(['2026-10-02', 'adj'])
    expect(kinds.filter(([, k]) => k === 'start')).toHaveLength(1)
    // September's opening balance is booked as a count correction where the sheet didn't add up.
    const sep = live(S.getDB().txns).find((t) => t.date === '2026-09-01' && t.kind === 'adj')!
    expect(sep.base).toBe(30000 - (100000 + 36000 - 80000))
    S.undo()
    expect(money()).toBe(had)
    expect(loggedIn('2026-08')).toHaveLength(0)
  })

  it('replacing a month removes what was logged here in it', () => {
    importSheet({ ...FILE, months: [{ ...FILE.months[1], month: '2026-10', txns: [{ date: '2026-10-04', cat: 'Living', amt: -5000, cur: 'TWD', base: -5000 }] }] }, ['2026-10'], ['2026-10'])
    expect(loggedIn('2026-10').map((t) => t.base)).toEqual([-5000])
    expect(avail('2026-10', 'Living')).toBe(40000 - 5000)
  })
})
