import { beforeEach, describe, expect, it } from 'vitest'
import { balances, cashAccounts, investAccounts, investmentsInPlan, netWorth, totalMoney, wealthSeries } from '../src/lib/accounts'
import { expectedTotal, monthView } from '../src/lib/budget'
import { merge } from '../src/lib/merge'
import { currenciesInUse } from '../src/lib/rates'
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

describe('an account that becomes an investment', () => {
  const index = () => S.getIndex()
  const setUp = () => {
    const bank = S.addAccount('Bank', 'TWD')
    const fund = S.addAccount('Vanguard', 'EUR') // counted as cash at first, like in onboarding
    S.recordCount({ date: '2026-10-01', bal: { [bank.id]: 500000, [fund.id]: 10000 }, rates: S.settings().rates, diffTo: RTA })
    return { bank, fund }
  }

  it('is the root cause: flagging it later leaves its money in the plan, and net worth counts it twice', () => {
    const { fund } = setUp()
    expect(totalMoney(index())).toBe(500000 + 10000 * 36)
    S.saveAccount({ ...fund, invest: 1 }) // what the toggle used to do
    expect(totalMoney(index())).toBe(500000 + 10000 * 36) // still in "Total money"
    expect(netWorth(index())).toBe(500000 + 10000 * 36 + 10000 * 36) // and again as an investment
  })

  it('moves the money out of the plan in one undoable step, and back', () => {
    const { bank, fund } = setUp()
    S.undoable('Investment', () => S.setInvestment(fund.id, true, '2026-10-05'))
    expect(totalMoney(index())).toBe(500000)
    expect(netWorth(index())).toBe(500000 + 10000 * 36)
    expect(bal('Vanguard')).toMatchObject({ bal: 10000 })
    const t = index().txns.find((x) => x.acct === fund.id)!
    expect(t).toMatchObject({ kind: 'adj', cat: RTA, base: -360000, note: 'Vanguard moved to investments' })
    // nothing to correct at the next count
    expect(S.previewCount({ date: '2026-10-06', bal: { [bank.id]: 500000 }, rates: S.settings().rates })).toMatchObject({ diff: 0, total: 500000 })
    expect(investmentsInPlan(index())).toEqual([])

    S.undo()
    expect(totalMoney(index())).toBe(500000 + 10000 * 36)
    expect(S.getDB().accounts[fund.id].invest).toBeUndefined()
    S.redo()
    expect(totalMoney(index())).toBe(500000)

    S.undoable('Investment', () => S.setInvestment(fund.id, false, '2026-10-07'))
    expect(totalMoney(index())).toBe(500000 + 10000 * 36)
    expect(netWorth(index())).toBe(totalMoney(index()))
    expect(S.getDB().accounts[fund.id].invest).toBeUndefined()
  })

  it('does not disturb tracked balances or the wealth series', () => {
    const { bank, fund } = setUp()
    S.setTrackAccounts(true)
    S.addTxn({ date: '2026-10-02', cat: cat('Living').id, amt: -20000, cur: 'TWD', acct: bank.id })
    S.setInvestment(fund.id, true, '2026-10-05')
    expect(bal('Bank').bal).toBe(480000)
    expect(bal('Vanguard').bal).toBe(10000)
    const w = wealthSeries(index(), ['2026-10'], '2026-10-22')
    expect(w[0]).toMatchObject({ cash: 480000, invest: 360000, total: 840000 })
    // and back as cash, the correction (which names the account) is not counted as its spending
    S.setInvestment(fund.id, false, '2026-10-06')
    expect(bal('Vanguard').bal).toBe(10000)
    expect(totalMoney(index())).toBe(480000 + 360000)
  })

  it('has no money to move when it was never counted', () => {
    const e = S.addAccount('New', 'TWD')
    const before = Object.keys(S.getDB().txns).length
    S.setInvestment(e.id, true, '2026-10-05')
    expect(Object.keys(S.getDB().txns).length).toBe(before)
    expect(S.getDB().accounts[e.id].invest).toBe(1)
  })

  it('finds an investment still counted in the plan, and takes it out once', () => {
    const { fund } = setUp()
    S.saveAccount({ ...fund, invest: 1 }) // flagged the old way
    expect(investmentsInPlan(index())).toEqual([{ acct: expect.objectContaining({ name: 'Vanguard' }), base: 360000 }])
    expect(S.takeOutOfPlan(fund.id, '2026-10-05')).toBe(360000)
    expect(totalMoney(index())).toBe(500000)
    expect(investmentsInPlan(index())).toEqual([])
    expect(S.takeOutOfPlan(fund.id, '2026-10-05')).toBe(0)
    expect(netWorth(index())).toBe(500000 + 10000 * 36)
  })

  it('sees nothing wrong when the account was an investment when counted, or counted since', () => {
    const bank = S.addAccount('Bank', 'TWD')
    const fund = S.addAccount('Fund', 'EUR', { invest: true })
    S.recordCount({ date: '2026-10-01', bal: { [bank.id]: 500000, [fund.id]: 10000 }, rates: S.settings().rates, diffTo: RTA })
    expect(investmentsInPlan(index())).toEqual([])
    // flagged late, then a cash count that left it out of the total
    const old = S.addAccount('Old', 'TWD')
    S.recordCount({ date: '2026-10-02', bal: { [bank.id]: 500000, [old.id]: 70000 }, rates: S.settings().rates, diffTo: RTA })
    S.saveAccount({ ...old, invest: 1 })
    expect(investmentsInPlan(index()).map((x) => x.acct.name)).toEqual(['Old'])
    S.recordCount({ date: '2026-10-03', bal: { [bank.id]: 500000 }, rates: S.settings().rates, diffTo: RTA })
    expect(investmentsInPlan(index())).toEqual([])
  })

  it('works out foreign balances at the count\'s own rates, with several investments', () => {
    const bank = S.addAccount('Bank', 'TWD')
    const a = S.addAccount('A', 'EUR')
    const b = S.addAccount('B', 'PLN')
    S.recordCount({ date: '2026-10-01', bal: { [bank.id]: 100000, [a.id]: 5000, [b.id]: 20000 }, rates: { EUR: 36, PLN: 8 }, diffTo: RTA })
    S.updateSettings({ rates: { EUR: 40, PLN: 9 } })
    S.saveAccount({ ...a, invest: 1 })
    S.saveAccount({ ...b, invest: 1 })
    expect(investmentsInPlan(index()).map((x) => [x.acct.name, x.base])).toEqual([
      ['A', 180000],
      ['B', 160000],
    ])
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

describe('ordering', () => {
  it('moves income sources', () => {
    const a = S.addSource('Salary')
    const b = S.addSource('Client')
    const c = S.addSource('Gifts')
    S.placeSource(c.id, 0)
    expect(S.sources().map((x) => x.name)).toEqual(['Gifts', 'Salary', 'Client'])
    S.placeSource(a.id, 99)
    expect(S.sources().map((x) => x.id)).toEqual([c.id, b.id, a.id])
  })

  it('moves accounts through the order field', () => {
    const a = S.addAccount('Cash', 'TWD')
    const b = S.addAccount('Bank', 'TWD')
    const c = S.addAccount('Wallet', 'TWD')
    S.placeAccount(c.id, 0)
    expect(cashAccounts(S.getIndex()).map((x) => x.name)).toEqual(['Wallet', 'Cash', 'Bank'])
    S.placeAccount(a.id, 2)
    expect(cashAccounts(S.getIndex()).map((x) => x.id)).toEqual([c.id, b.id, a.id])
  })

  it('moves an account within its kind, leaving the other kind where it is', () => {
    const cash = S.addAccount('Cash', 'TWD')
    const stocks = S.addAccount('Stocks', 'EUR', { invest: true })
    const bank = S.addAccount('Bank', 'TWD')
    const fund = S.addAccount('Fund', 'EUR', { invest: true })
    S.placeAccountOfKind(bank.id, 0)
    expect(cashAccounts(S.getIndex()).map((x) => x.id)).toEqual([bank.id, cash.id])
    expect(investAccounts(S.getIndex()).map((x) => x.id)).toEqual([stocks.id, fund.id])
    S.placeAccountOfKind(fund.id, 0)
    expect(investAccounts(S.getIndex()).map((x) => x.id)).toEqual([fund.id, stocks.id])
    expect(cashAccounts(S.getIndex()).map((x) => x.id)).toEqual([bank.id, cash.id])
    // a move that changes nothing writes nothing
    const before = S.getDB().accounts[cash.id].u
    S.placeAccountOfKind(fund.id, 0)
    expect(S.getDB().accounts[cash.id].u).toBe(before)
  })

  it('moves chosen currencies, the base staying first', () => {
    S.updateSettings({ extraCurrencies: ['EUR', 'PLN', 'USD'] })
    S.placeCurrency('USD', 0)
    expect(S.settings().extraCurrencies).toEqual(['USD', 'EUR', 'PLN'])
    S.placeCurrency('USD', 5)
    expect(S.settings().extraCurrencies).toEqual(['EUR', 'PLN', 'USD'])
    S.placeCurrency('JPY', 0) // not chosen: nothing happens
    expect(S.settings().extraCurrencies).toEqual(['EUR', 'PLN', 'USD'])
    // the order is the one the entry screens offer
    expect(currenciesInUse()).toEqual(['TWD', 'EUR', 'PLN', 'USD'])
  })

  it('undoes a move', () => {
    const a = S.addAccount('Cash', 'TWD')
    S.addAccount('Bank', 'TWD')
    S.clearUndo()
    S.undoable('Moved account', () => S.placeAccount(a.id, 1))
    expect(cashAccounts(S.getIndex()).map((x) => x.name)).toEqual(['Bank', 'Cash'])
    S.undo()
    expect(cashAccounts(S.getIndex()).map((x) => x.name)).toEqual(['Cash', 'Bank'])
  })

  it('keeps an order that two devices set apart', () => {
    const a = S.addAccount('Cash', 'TWD')
    const b = S.addAccount('Bank', 'TWD')
    const c = S.addAccount('Wallet', 'TWD')
    const shared = S.getDB()
    S.placeAccount(c.id, 0)
    S.saveAccount({ ...S.getDB().accounts[a.id], name: 'Petty cash' })
    const one = S.getDB()
    S.replaceDB(shared)
    S.placeAccountOfKind(b.id, 0)
    const two = S.getDB()
    const merged = merge(one, two)
    expect(merge(two, one)).toEqual(merged)
    // the rename survives next to somebody's reorder
    expect(merged.accounts[a.id].name).toBe('Petty cash')
  })
})

describe('last typed balance', () => {
  it('says when and what, even once transactions moved the balance on', () => {
    const a = S.addAccount('Bank', 'TWD')
    expect(bal('Bank').typedBal).toBeNull()
    S.recordCount({ date: '2026-10-01', bal: { [a.id]: 500000 }, rates: S.settings().rates, diffTo: RTA })
    S.setTrackAccounts(true)
    S.addTxn({ date: '2026-10-03', cat: cat('Living').id, amt: -20000, cur: 'TWD', acct: a.id })
    expect(bal('Bank').bal).toBe(480000)
    expect(bal('Bank').asOf).toBe('2026-10-01')
    expect(bal('Bank').typedBal).toBe(500000)
  })
})
