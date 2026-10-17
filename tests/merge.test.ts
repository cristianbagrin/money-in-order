import { beforeEach, describe, expect, it } from 'vitest'
import { buildIndex, monthView } from '../src/lib/budget'
import { hasNews, merge, mergeRec, repair } from '../src/lib/merge'
import * as S from '../src/lib/store'
import { emptyDB, type Category, type DB } from '../src/lib/types'

const OCT = '2026-10'

function cat(db: DB, name: string): Category {
  return Object.values(db.cats).find((c) => c.name === name)!
}

/** A synced starting point both "devices" share. */
let shared: DB

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: { EUR: 36.16 }, savingsTarget: 0.2 })
  S.seedCategories()
  S.clearUndo()
  shared = S.getDB()
})

/** Run edits on a copy of the shared state, as another device would, and return that device's database. */
function device(edits: () => void, from: DB = shared): DB {
  S.replaceDB(from)
  edits()
  return S.getDB()
}

function converge(a: DB, b: DB): DB {
  const ab = merge(a, b)
  const ba = merge(b, a)
  expect(ab).toEqual(ba)
  expect(merge(ab, a)).toEqual(ab)
  expect(merge(ab, b)).toEqual(ab)
  expect(hasNews(ab, a)).toBe(false)
  expect(hasNews(ab, b)).toBe(false)
  return ab
}

describe('field-level merge', () => {
  it('keeps a rename from one device and a reorder from the other', () => {
    const phone = cat(shared, 'Phone')
    const a = device(() => S.saveCategory({ ...phone, name: 'Mobile' }))
    const b = device(() => S.placeCategory(phone.id, phone.group, 9))
    expect(b.cats[phone.id].u).toBeGreaterThan(a.cats[phone.id].u)
    const m = converge(a, b)
    expect(m.cats[phone.id].name).toBe('Mobile')
    expect(m.cats[phone.id].order).toBe(b.cats[phone.id].order)
    expect(hasNews(a, b)).toBe(true)
    expect(hasNews(b, a)).toBe(true)
  })

  it('takes the newer value when both devices change the same field', () => {
    const phone = cat(shared, 'Phone')
    const a = device(() => S.saveCategory({ ...phone, name: 'Mobile' }))
    const b = device(() => S.saveCategory({ ...phone, name: 'Cell' }))
    expect(converge(a, b).cats[phone.id].name).toBe('Cell')
  })

  it('keeps a transaction note from one device and its category from the other', () => {
    const living = cat(shared, 'Living')
    const other = cat(shared, 'Other')
    const t = S.addTxn({ date: '2026-10-05', cat: living.id, amt: -10000, cur: 'TWD' })
    shared = S.getDB()
    const a = device(() => S.updateTxn(t.id, { note: 'lunch' }))
    const b = device(() => S.updateTxn(t.id, { cat: other.id }))
    const m = converge(a, b)
    expect(m.txns[t.id]).toMatchObject({ note: 'lunch', cat: other.id, amt: -10000 })
  })

  it('never mixes an amount from one device with a currency from the other', () => {
    const living = cat(shared, 'Living')
    const t = S.addTxn({ date: '2026-10-05', cat: living.id, amt: -10000, cur: 'TWD' })
    shared = S.getDB()
    const a = device(() => S.updateTxn(t.id, { amt: -20000 }))
    const b = device(() => S.updateTxn(t.id, { cur: 'EUR', note: 'Paris' }))
    const m = converge(a, b).txns[t.id]
    expect(m).toMatchObject({ amt: -10000, cur: 'EUR', base: b.txns[t.id].base, note: 'Paris' })
  })

  it('merges a cleared field as a change', () => {
    const living = cat(shared, 'Living')
    const a = device(() => S.saveCategory({ ...living, note: undefined }))
    const b = device(() => S.saveCategory({ ...living, daily: false }))
    const m = converge(a, b)
    expect(m.cats[living.id].note).toBeUndefined()
    expect(m.cats[living.id].daily).toBe(false)
  })

  it('is associative across three devices', () => {
    const phone = cat(shared, 'Phone')
    const a = device(() => S.saveCategory({ ...phone, name: 'Mobile' }))
    const b = device(() => S.saveCategory({ ...phone, note: 'contract' }))
    const c = device(() => S.saveCategory({ ...phone, target: { kind: 'monthly', amount: 50000 } }))
    const left = merge(merge(a, b), c)
    const right = merge(a, merge(b, c))
    expect(left).toEqual(right)
    expect(left.cats[phone.id]).toMatchObject({ name: 'Mobile', note: 'contract', target: { amount: 50000 } })
  })

  it('treats records without field times as changed all at once', () => {
    const base = { id: 'x', u: 5, name: 'A', order: 1, group: 'g' }
    const newer = { id: 'x', u: 9, name: 'B', group: 'g' }
    expect(mergeRec(base, newer)).toBe(newer)
    expect(mergeRec(newer, base)).toBe(newer)
  })

  it('ignores field times an older app version left behind when it edited the record', () => {
    const fresh = { id: 'x', u: 10, name: 'A', order: 2, f: { $: 10, _: 5, order: 10 } }
    // An old version renamed it at 20, copied the stale f and bumped u: every field counts as written at 20.
    const old = { ...fresh, u: 20, name: 'B', order: 1 }
    const m = mergeRec(fresh, old)
    expect(m).toMatchObject({ name: 'B', order: 1 })
  })

  it('keeps deletion per record: the newest write decides', () => {
    const phone = cat(shared, 'Phone')
    const del = device(() => S.deleteCategory(phone.id))
    const later = device(() => S.saveCategory({ ...phone, name: 'Mobile' }))
    expect(converge(del, later).cats[phone.id].d).toBeUndefined()
    const earlier = device(() => S.saveCategory({ ...phone, name: 'Mobile' }))
    const del2 = device(() => S.deleteCategory(phone.id))
    expect(converge(earlier, del2).cats[phone.id].d).toBe(1)
  })

  it('does not rewrite records that did not change', () => {
    const phone = cat(shared, 'Phone')
    S.saveCategory({ ...phone })
    expect(S.getDB().cats[phone.id]).toBe(shared.cats[phone.id])
  })
})

describe('rates are kept apart from settings', () => {
  it('a rate refresh from a stale device never reverts settings changed elsewhere', () => {
    const desk = device(() => S.updateSettings({ savingsTarget: 0.3, extraCurrencies: ['EUR'] }))
    const phone = device(() => S.updateSettings({ rates: { EUR: 37 }, ratesAt: Date.now() }))
    expect(phone.meta.settings).toBe(shared.meta.settings)
    S.replaceDB(converge(desk, phone))
    expect(S.settings()).toMatchObject({ savingsTarget: 0.3, extraCurrencies: ['EUR'], rates: { EUR: 37 } })
  })

  it('reads rates from the settings record of an older budget', () => {
    const legacy = emptyDB()
    legacy.meta.settings = { id: 'settings', u: 1, base: 'TWD', rates: { EUR: 35 }, ratesAt: 7, savingsTarget: 0.2, extraCurrencies: ['EUR'] }
    S.replaceDB(legacy)
    expect(S.settings().rates).toEqual({ EUR: 35 })
    S.updateSettings({ rates: { EUR: 36 }, ratesAt: 8 })
    expect(S.settings()).toMatchObject({ rates: { EUR: 36 }, ratesAt: 8 })
    expect(S.getDB().meta.settings!.rates).toEqual({ EUR: 35 })
  })

  it('ignores a rate table made for another budget currency', () => {
    S.updateSettings({ rates: { EUR: 36 }, ratesAt: 8 })
    const desk = device(() => S.changeBase('EUR'), S.getDB())
    expect(S.settings().base).toBe('EUR')
    expect(S.settings().rates.TWD).toBeCloseTo(1 / 36, 5)
    // A refresh that started before the change lands afterwards: its TWD-based table must not be used.
    const stale = device(() => S.updateSettings({ base: 'TWD', rates: { EUR: 37 }, ratesAt: 9 }), shared)
    const m = merge(desk, { ...emptyDB(), meta: { rates: stale.meta.rates } })
    expect(buildIndex(m).settings.base).toBe('EUR')
    expect(buildIndex(m).settings.rates.TWD).toBeCloseTo(1 / 36, 5)
  })
})

describe('repair after a merge', () => {
  it('brings back a deleted category that still has spending, archived, the same way on every device', () => {
    S.addCategory(cat(shared, 'Other').group, 'Gifts')
    shared = S.getDB()
    const gifts = cat(shared, 'Gifts')
    const phone = device(() => S.addTxn({ date: '2026-10-05', cat: gifts.id, amt: -25000, cur: 'TWD' }))
    const desk = device(() => S.deleteCategory(gifts.id))
    const m1 = repair(merge(phone, desk))
    const m2 = repair(merge(desk, phone))
    expect(m1).toEqual(m2)
    expect(m1.cats[gifts.id]).toMatchObject({ archived: 1, name: 'Gifts' })
    expect(m1.cats[gifts.id].d).toBeUndefined()
    expect(m1.cats[gifts.id].u).toBe(desk.cats[gifts.id].u + 1)
    expect(repair(m1)).toBe(m1)
    // The spending still counts.
    const v = monthView(buildIndex(m1), OCT, OCT)
    expect(v.byId.get(gifts.id)?.activity).toBe(-25000)
  })

  it('brings back a deleted group while an active category is in it', () => {
    S.addGroup('Temp')
    shared = S.getDB()
    const temp = Object.values(shared.groups).find((g) => g.name === 'Temp')!
    const phone = device(() => {
      const c = S.addCategory(temp.id, 'Dentist')
      S.setAssigned(OCT, c.id, 150000)
    })
    const desk = device(() => S.deleteGroup(temp.id))
    const m = repair(merge(phone, desk))
    expect(m.groups[temp.id].d).toBeUndefined()
    expect(repair(merge(desk, phone))).toEqual(m)
    const v = monthView(buildIndex(m), OCT, OCT)
    expect(v.groups.find((g) => g.group.id === temp.id)?.cats.map((c) => c.cat.name)).toEqual(['Dentist'])
  })

  it('does not bring back a group for archived categories only', () => {
    const g = Object.values(shared.groups).find((x) => x.name === 'Future')!
    for (const c of Object.values(shared.cats)) if (c.group === g.id) S.saveCategory({ ...c, archived: 1 })
    S.deleteGroup(g.id)
    expect(S.getDB().groups[g.id].d).toBe(1)
  })

  it('shows a category whose group is missing under the first group', () => {
    const living = cat(shared, 'Living')
    S.saveCategory({ ...living, group: 'gone' })
    S.setAssigned(OCT, living.id, 100000)
    const v = monthView(S.getIndex(), OCT, OCT)
    expect(v.groups[0].cats.some((c) => c.cat.id === living.id)).toBe(true)
    expect(v.groups.flatMap((g) => g.cats).filter((c) => c.cat.id === living.id)).toHaveLength(1)
  })
})

describe('undo by field', () => {
  it('undoing a rename keeps a reorder that arrived from another device', () => {
    const phone = cat(shared, 'Phone')
    S.undoable('Renamed category', () => S.saveCategory({ ...phone, name: 'Mobile' }))
    const mine = S.getDB()
    const other = device(() => S.placeCategory(phone.id, phone.group, 9))
    S.replaceDB(merge(mine, other))
    // replaceDB from sync keeps the undo history
    S.undo()
    const c = S.getDB().cats[phone.id]
    expect(c.name).toBe('Phone')
    expect(c.order).toBe(other.cats[phone.id].order)
    S.redo()
    expect(S.getDB().cats[phone.id]).toMatchObject({ name: 'Mobile', order: other.cats[phone.id].order })
  })

  it('an undo on one device merges with other edits on the other', () => {
    const living = cat(shared, 'Living')
    S.undoable('Changed target', () => S.saveCategory({ ...living, target: { kind: 'monthly', amount: 600000 } }))
    shared = S.getDB()
    const a = S.getDB()
    S.undo()
    const undone = S.getDB()
    const b = device(() => S.saveCategory({ ...living, name: 'Food' }), a)
    const m = merge(undone, b)
    expect(m.cats[living.id].target).toBeUndefined()
    expect(m.cats[living.id].name).toBe('Food')
  })

  it('undoes and redoes a deletion and a creation', () => {
    const living = cat(shared, 'Living')
    const t = S.undoable('Logged', () => S.addTxn({ date: '2026-10-05', cat: living.id, amt: -100, cur: 'TWD', note: 'x' }))
    S.undo()
    expect(S.getDB().txns[t.id].d).toBe(1)
    S.redo()
    expect(S.getDB().txns[t.id]).toMatchObject({ note: 'x' })
    expect(S.getDB().txns[t.id].d).toBeUndefined()
    S.undoable('Deleted', () => S.deleteTxn(t.id))
    S.undo()
    expect(S.getDB().txns[t.id].d).toBeUndefined()
    expect(S.getDB().txns[t.id].note).toBe('x')
  })
})
