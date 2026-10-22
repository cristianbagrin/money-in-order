import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addDays, isoDate } from '../src/lib/dates'
import { currenciesInUse, hasRate, recentCurrencies, refreshRates } from '../src/lib/rates'
import * as S from '../src/lib/store'
import { emptyDB } from '../src/lib/types'

const today = isoDate()
let cat: string

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', extraCurrencies: ['TWD', 'USD'] })
  S.updateSettings({ rates: { USD: 30 }, ratesAt: Date.now() })
  S.seedCategories()
  cat = Object.values(S.getDB().cats)[0].id
})

const txn = (id: string) => S.getDB().txns[id]
/** The rate moves on after an entry was made. */
const rateMoves = (usd: number) => S.updateSettings({ rates: { ...S.settings().rates, USD: usd } })

describe('a logged amount is fixed at the rate of the day it was entered', () => {
  it('is converted once, when added', () => {
    const t = S.addTxn({ date: today, cat, amt: -1000, cur: 'USD' })
    expect(t.base).toBe(-30000)
    rateMoves(40)
    expect(txn(t.id).base).toBe(-30000)
  })

  it('stays put when only the note, category, date or account change, however the rate moved', () => {
    const other = Object.values(S.getDB().cats)[1].id
    const t = S.addTxn({ date: today, cat, amt: -1000, cur: 'USD' })
    rateMoves(45)
    S.updateTxn(t.id, { note: 'lunch' })
    S.updateTxn(t.id, { cat: other })
    S.updateTxn(t.id, { date: addDays(today, -3) })
    S.updateTxn(t.id, { acct: 'some-account' })
    const after = txn(t.id)
    expect(after.base).toBe(-30000)
    expect(after.amt).toBe(-1000)
    expect(after.cur).toBe('USD')
  })

  it('stays put when the amount is "changed" to the same figure', () => {
    const t = S.addTxn({ date: today, cat, amt: -333, cur: 'USD' })
    rateMoves(31.7)
    S.updateTxn(t.id, { amt: -333, note: 'same' })
    expect(txn(t.id).base).toBe(t.base)
  })

  it('keeps the original rate when the amount changes in the same currency', () => {
    const t = S.addTxn({ date: today, cat, amt: -1000, cur: 'USD' })
    rateMoves(40)
    S.updateTxn(t.id, { amt: -2000 })
    expect(txn(t.id).base).toBe(-60000) // 2 x the entry's 30, not 2 x today's 40
    S.updateTxn(t.id, { amt: -500 })
    expect(txn(t.id).base).toBe(-15000)
  })

  it('keeps the original rate through a category change that flips the sign (spending to income)', () => {
    const t = S.addTxn({ date: today, cat, amt: -1000, cur: 'USD' })
    rateMoves(40)
    S.updateTxn(t.id, { cat: 'rta', amt: 1000 })
    expect(txn(t.id).base).toBe(30000)
  })

  it('recomputes only when the currency itself changes, at the rate of that moment', () => {
    S.updateSettings({ rates: { ...S.settings().rates, EUR: 35 } })
    const t = S.addTxn({ date: today, cat, amt: -1000, cur: 'USD' })
    rateMoves(40)
    S.updateTxn(t.id, { cur: 'EUR' })
    expect(txn(t.id).base).toBe(-35000)
    // ...and from then on it is fixed again at that rate
    S.updateSettings({ rates: { ...S.settings().rates, EUR: 50 } })
    S.updateTxn(t.id, { note: 'x' })
    expect(txn(t.id).base).toBe(-35000)
    S.updateTxn(t.id, { amt: -2000 })
    expect(txn(t.id).base).toBe(-70000)
  })

  it('an explicit base is honoured', () => {
    const t = S.addTxn({ date: today, cat, amt: -1000, cur: 'USD' })
    S.updateTxn(t.id, { amt: -1100, base: -31234 })
    expect(txn(t.id).base).toBe(-31234)
  })

  it('a base-currency entry is never touched by the rates', () => {
    const t = S.addTxn({ date: today, cat, amt: -5000, cur: 'TWD' })
    rateMoves(99)
    S.updateTxn(t.id, { note: 'a' })
    expect(txn(t.id).base).toBe(-5000)
    S.updateTxn(t.id, { amt: -7000 })
    expect(txn(t.id).base).toBe(-7000)
  })

  it('undo puts the original base back', () => {
    const t = S.addTxn({ date: today, cat, amt: -1000, cur: 'USD' })
    rateMoves(40)
    S.undoable('Edited', () => S.updateTxn(t.id, { cur: 'TWD' }))
    expect(txn(t.id).base).toBe(-1000)
    S.undo()
    expect(txn(t.id).base).toBe(-30000)
  })
})

describe('currencies in use while travelling', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a foreign currency spent in lately counts as in use, then drops off on its own', () => {
    expect(currenciesInUse()).toEqual(['TWD', 'USD'])
    S.addTxn({ date: addDays(today, -2), cat, amt: -5000, cur: 'THB' })
    expect(recentCurrencies()).toEqual(['THB'])
    expect(currenciesInUse()).toEqual(['TWD', 'USD', 'THB'])
  })

  it('drops off once the last use is older than a month', () => {
    S.addTxn({ date: addDays(today, -60), cat, amt: -5000, cur: 'THB' })
    expect(currenciesInUse()).toEqual(['TWD', 'USD'])
  })

  it('ignores deleted entries, the base currency and non-spending records', () => {
    const t = S.addTxn({ date: today, cat, amt: -5000, cur: 'THB' })
    S.addTxn({ date: today, cat, amt: -5000, cur: 'TWD' })
    S.addTxn({ date: today, cat, amt: -5000, cur: 'JPY', kind: 'adj' })
    expect(recentCurrencies()).toEqual(['THB'])
    S.deleteTxn(t.id)
    expect(recentCurrencies()).toEqual([])
  })

  it('refreshRates can be asked for extra codes, and fetches a missing one even when the rates are fresh', async () => {
    expect(hasRate('THB')).toBe(false)
    const fetched = vi.fn(async () => ({ ok: true, json: async () => ({ twd: { usd: 1 / 30, thb: 1 / 0.9, jpy: 4.5 } }) }))
    vi.stubGlobal('fetch', fetched)
    expect(await refreshRates(false, ['THB'])).toBe(true)
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(hasRate('THB')).toBe(true)
    expect(S.settings().rates.THB).toBeCloseTo(0.9, 6)
    expect(hasRate('JPY')).toBe(false) // only what was asked for
    // fresh and complete now: no more requests
    expect(await refreshRates(false, ['THB'])).toBe(false)
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it('offline: no rate is fetched and the currency stays without one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    expect(await refreshRates(false, ['THB'])).toBe(false)
    expect(hasRate('THB')).toBe(false)
  })
})
