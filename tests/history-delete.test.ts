import { beforeEach, describe, expect, it } from 'vitest'
import * as S from '../src/lib/store'
import { emptyDB } from '../src/lib/types'

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD' })
  S.seedCategories()
})

describe('deleteTxns', () => {
  it('deletes a batch as one undoable step', () => {
    const cat = Object.values(S.getDB().cats)[0]
    const ts = [1, 2, 3].map((n) => S.addTxn({ date: '2026-10-05', cat: cat.id, amt: -n * 100, cur: 'TWD', note: `n${n}` }))
    S.undoable('Deleted', () => S.deleteTxns([ts[0].id, ts[2].id, 'missing']))
    expect(S.getDB().txns[ts[0].id].d).toBe(1)
    expect(S.getDB().txns[ts[1].id].d).toBeUndefined()
    expect(S.getDB().txns[ts[2].id].d).toBe(1)
    S.undo()
    expect(S.getDB().txns[ts[0].id].d).toBeUndefined()
    expect(S.getDB().txns[ts[2].id].d).toBeUndefined()
  })
})
