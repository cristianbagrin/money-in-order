import { describe, expect, it } from 'vitest'
import { evalAmount, fmt, groupTyped, shownSign } from '../src/lib/money'

describe('groupTyped', () => {
  it('puts thousands separators in as you type', () => {
    expect(groupTyped('1234')).toBe('1,234')
    expect(groupTyped('1234567.5')).toBe('1,234,567.5')
    expect(groupTyped('12,34')).toBe('1,234')
    expect(groupTyped('6000+500')).toBe('6,000+500')
    expect(groupTyped('-12000')).toBe('-12,000')
    expect(groupTyped('123')).toBe('123')
    expect(groupTyped('1000.')).toBe('1,000.')
    expect(groupTyped('')).toBe('')
  })
  it('reads back as the same amount', () => {
    for (const s of ['1234', '1234567.5', '6000+500', '1200*3', '99999.99']) {
      expect(evalAmount(groupTyped(s))).toBe(evalAmount(s))
    }
  })
})

describe('zero as shown', () => {
  it('a sliver that rounds to zero has no minus', () => {
    expect(fmt(-30, 'TWD')).toBe('NT$0')
    expect(shownSign(-30, 'TWD')).toBe(0)
    expect(shownSign(-60, 'TWD')).toBe(-1)
    expect(shownSign(-1, 'EUR')).toBe(-1)
    expect(fmt(-100, 'TWD')).toBe('−NT$1')
  })
})
