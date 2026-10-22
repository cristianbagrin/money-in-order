import { beforeEach, describe, expect, it } from 'vitest'
import { balances, netWorth, totalMoney, wealthSeries } from '../src/lib/accounts'
import { expectedTotal, monthView } from '../src/lib/budget'
import * as S from '../src/lib/store'
import { emptyDB, RTA, type Category } from '../src/lib/types'

const cat = (name: string): Category => Object.values(S.getDB().cats).find((c) => c.name === name)!
const bal = (name: string) => balances(S.getIndex()).find((b) => b.acct.name === name)!

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: { EUR: 36, PLN: 8 } })
  S.seedCategories()
})

describe('counting some accounts', () => {
  it('keeps the accounts left out at what was known', () => {
    const a = S.addAccount('Cash', 'TWD')
    const b = S.addAccount('Bank', 'TWD')
    S.recordCount({ date: '2026-10-01', bal: { [a.id]: 100000, [b.id]: 500000 }, rates: S.settings().rates, diffTo: RTA })
    expect(expectedTotal(S.getIndex())).toBe(600000)
    S.addTxn({ date: '2026-10-03', cat: cat('Living').id, amt: -20000, cur: 'TWD' })
    // only Cash is recounted: the bank is assumed unchanged
    const r = S.recordCount({ date: '2026-10-05', bal: { [a.id]: 80000 }, rates: S.settings().rates, diffTo: RTA })
    expect(r.carried).toEqual([b.id])
    expect(r.total).toBe(580000)
    expect(r.diff).toBe(0)
    const c = S.lastCount()!
    expect(c.bal[b.id]).toBe(500000)
    expect(c.carried).toEqual([b.id])
    expect(bal('Bank').asOf).toBe('2026-10-01')
    expect(bal('Cash').asOf).toBe('2026-10-05')
  })

  it('updating only an investment never touches the plan', () => {
    const a = S.addAccount('Bank', 'TWD')
    const inv = S.addAccount('Stocks', 'EUR', { invest: true })
    S.recordCount({ date: '2026-10-01', bal: { [a.id]: 500000, [inv.id]: 100000 }, rates: S.settings().rates, diffTo: RTA })
    expect(expectedTotal(S.getIndex())).toBe(500000) // the investment is not plan money
    S.addTxn({ date: '2026-10-03', cat: cat('Living').id, amt: -20000, cur: 'TWD' })
    const before = Object.keys(S.getDB().txns).length
    const r = S.recordCount({ date: '2026-10-10', bal: { [inv.id]: 120000 }, rates: S.settings().rates, diffTo: RTA })
    expect(r.cash).toBe(false)
    expect(Object.keys(S.getDB().txns).length).toBe(before)
    expect(bal('Stocks').bal).toBe(120000)
    expect(netWorth(S.getIndex())).toBe(totalMoney(S.getIndex()) + 120000 * 36)
  })
})

describe('tracked accounts and moves', () => {
  it('follows spending, income and moves once tracked', () => {
    const a = S.addAccount('Cash', 'TWD')
    const b = S.addAccount('Euro', 'EUR')
    S.recordCount({ date: '2026-10-01', bal: { [a.id]: 100000, [b.id]: 10000 }, rates: S.settings().rates, diffTo: RTA })
    S.setTrackAccounts(true)
    S.addTxn({ date: '2026-10-02', cat: cat('Living').id, amt: -30000, cur: 'TWD', acct: a.id })
    S.addTxn({ date: '2026-10-02', cat: RTA, amt: 5000, cur: 'EUR', acct: b.id })
    const before = expectedTotal(S.getIndex())
    S.addMove({ date: '2026-10-03', from: a.id, to: b.id, amt: 36000 })
    expect(expectedTotal(S.getIndex())).toBe(before) // a move changes nothing in the plan
    expect(monthView(S.getIndex(), '2026-10', '2026-10').income).toBe(5000 * 36)
    expect(bal('Cash').bal).toBe(100000 - 30000 - 36000)
    expect(bal('Euro').bal).toBe(10000 + 5000 + 1000)
    S.setTrackAccounts(false)
    expect(bal('Cash').bal).toBe(100000)
  })

  it('money spent from a linked savings category goes into the investment', () => {
    const a = S.addAccount('Bank', 'TWD')
    const inv = S.addAccount('Fund', 'TWD', { invest: true })
    S.recordCount({ date: '2026-09-30', bal: { [a.id]: 500000, [inv.id]: 200000 }, rates: S.settings().rates, diffTo: RTA })
    S.saveCategory({ ...cat('Future me'), acct: inv.id })
    S.addTxn({ date: '2026-10-05', cat: cat('Future me').id, amt: -50000, cur: 'TWD' })
    expect(bal('Fund').bal).toBe(250000)
    expect(monthView(S.getIndex(), '2026-10', '2026-10').spent).toBe(0) // invested, not spent
    const w = wealthSeries(S.getIndex(), ['2026-09', '2026-10'], '2026-10-22')
    expect(w[0]).toMatchObject({ cash: 500000, invest: 200000, total: 700000, added: 0 })
    expect(w[1]).toMatchObject({ cash: 450000, invest: 250000, total: 700000, added: 50000 })
  })
})

describe('deleting a category for good', () => {
  it('moves its transactions and money into another', () => {
    const living = cat('Living')
    const other = cat('Other')
    S.setAssigned('2026-10', living.id, 50000)
    S.setAssigned('2026-10', other.id, 10000)
    S.addTxn({ date: '2026-10-02', cat: living.id, amt: -20000, cur: 'TWD' })
    S.deleteCategory(living.id, { into: other.id })
    const v = monthView(S.getIndex(), '2026-10', '2026-10')
    expect(v.byId.get(living.id)).toBeUndefined()
    expect(v.byId.get(other.id)).toMatchObject({ assigned: 60000, activity: -20000, available: 40000 })
    expect(S.getDB().cats[living.id].d).toBe(1) // not revived by repair
  })

  it('can drop its transactions instead', () => {
    const living = cat('Living')
    S.addTxn({ date: '2026-10-02', cat: RTA, amt: 100000, cur: 'TWD' })
    S.setAssigned('2026-10', living.id, 50000)
    S.addTxn({ date: '2026-10-02', cat: living.id, amt: -20000, cur: 'TWD' })
    S.deleteCategory(living.id, { dropTxns: true })
    expect(S.getDB().cats[living.id].d).toBe(1)
    expect(expectedTotal(S.getIndex())).toBe(100000)
    expect(monthView(S.getIndex(), '2026-10', '2026-10').readyToAssign).toBe(100000)
  })
})

describe('income sources', () => {
  it('adds, renames and removes', () => {
    const s = S.addSource('Salary')
    S.addSource('Client')
    S.renameSource(s.id, 'Job')
    expect(S.sources().map((x) => x.name)).toEqual(['Job', 'Client'])
    S.deleteSource(s.id)
    expect(S.sources().map((x) => x.name)).toEqual(['Client'])
  })
})
