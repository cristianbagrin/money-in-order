import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// A stand-in for IndexedDB and the browser, enough for the sync module's own bookkeeping.
const kv = new Map<string, unknown>()
vi.mock('idb-keyval', () => ({
  get: async (k: string) => kv.get(k),
  set: async (k: string, v: unknown) => void kv.set(k, v),
  update: async (k: string, f: (v: unknown) => unknown) => void kv.set(k, f(kv.get(k))),
}))

let online = false
beforeAll(() => {
  const target = new EventTarget()
  Object.defineProperty(globalThis, 'navigator', { value: { get onLine() { return online } }, configurable: true })
  Object.assign(globalThis, {
    window: target,
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sync status', () => {
  it('turns stale when changes made here have not reached the server for ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval'] })
    const sync = await import('../src/lib/sync')
    const S = await import('../src/lib/store')
    await sync.enableSync('ABCDE-FGHJK-MNPQR-STUVW')
    expect(sync.syncStatus()).toMatchObject({ state: 'offline', stale: false })
    expect(sync.syncStatus().error).toBe('Offline. Changes will sync when you’re back.')
    let heard = 0
    const off = sync.onSyncStatus(() => heard++)
    S.updateSettings({ savingsTarget: 0.25 })
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
    expect(sync.syncStatus().stale).toBe(false)
    heard = 0
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(sync.syncStatus().stale).toBe(true)
    expect(heard).toBeGreaterThan(0)
    off()
    await sync.disableSync()
    expect(sync.syncStatus().stale).toBe(false)
  })
})
