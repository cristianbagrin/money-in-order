import { beforeEach, describe, expect, it } from 'vitest'
import * as S from '../src/lib/store'
import { emptyDB, RTA } from '../src/lib/types'
import { slicesOf } from '../src/ui/charts'
import { situationText } from '../src/views/Review'

const u = (major: number) => major * 100
const TODAY = '2026-10-15'
const ix = () => S.getIndex()

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: {}, savingsTarget: 0.2 })
  S.seedCategories()
})

describe('situation text', () => {
  it('states the figures and asks nothing', () => {
    const cat = Object.values(S.getDB().cats)[0]
    S.addTxn({ date: '2026-10-02', cat: RTA, amt: u(50000), cur: 'TWD' })
    S.setAssigned('2026-10', cat.id, u(8000))
    S.saveCategory({ ...cat, target: { kind: 'monthly', amount: u(8000) } })
    S.addTxn({ date: '2026-10-05', cat: cat.id, amt: -u(1200), cur: 'TWD' })
    const text = situationText(ix(), TODAY)
    expect(text).toContain('Amounts in TWD')
    expect(text).toContain('Ready to assign: NT$42,000')
    expect(text).toContain(`- ${cat.name}: assigned NT$8,000, spent NT$1,200, target NT$8,000 a month`)
    expect(text).not.toMatch(/\?|please|you should/i)
  })

  it('leaves out categories with nothing going on', () => {
    const lines = situationText(ix(), TODAY)
      .split('\n')
      .filter((l) => l.startsWith('- '))
    expect(lines).toEqual([])
  })
})

describe('donut slices', () => {
  it('give neighbouring slices different colours', () => {
    const { slices } = slicesOf(Array.from({ length: 8 }, (_, k) => ({ id: `c${k}`, name: `C${k}`, amount: 1000 - k * 50 })))
    for (let k = 1; k < slices.length; k++) expect(slices[k].color).not.toBe(slices[k - 1].color)
  })
})
