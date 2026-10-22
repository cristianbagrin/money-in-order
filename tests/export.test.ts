import { beforeEach, describe, expect, it } from 'vitest'
import { claudeSummary } from '../src/lib/export'
import * as S from '../src/lib/store'
import { emptyDB, RTA, type Category } from '../src/lib/types'

const cat = (name: string): Category => Object.values(S.getDB().cats).find((c) => c.name === name)!

beforeEach(() => {
  S.replaceDB(emptyDB())
  S.updateSettings({ base: 'TWD', rates: {}, savingsTarget: 0.2 })
  S.seedCategories()
})

describe('summary for Claude', () => {
  it('tells net worth, investments and income by source', () => {
    const bank = S.addAccount('Bank', 'TWD')
    const fund = S.addAccount('Fund', 'TWD', { invest: true })
    S.recordCount({ date: '2026-08-31', bal: { [bank.id]: 50000000, [fund.id]: 20000000 }, rates: {}, diffTo: RTA })
    const job = S.addSource('Salary')
    for (const m of ['2026-09', '2026-10']) {
      S.addTxn({ date: `${m}-01`, cat: RTA, amt: 6000000, cur: 'TWD', src: job.id })
      S.addTxn({ date: `${m}-05`, cat: cat('Living').id, amt: -1500000, cur: 'TWD' })
    }
    const text = claudeSummary(S.getIndex(), '2026-10-22', { months: 6, transactions: false })
    expect(text).toContain('- Investments: Fund NT$200,000 (value typed 2026-08-31)')
    expect(text).toContain('- Net worth (budget money + investments): NT$790,000')
    expect(text).toContain('## Net worth at each month end')
    expect(text).toContain('## Income by source, October so far')
    expect(text).toContain('- Salary: NT$60,000 (usual month NT$30,000)')
    expect(text).toContain('2026-10-01 · NT$60,000 · Salary')
    expect(text).toContain('## October so far vs usual')
  })
})
