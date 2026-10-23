import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stores } from './fake-blobs'

// Two devices against the real vault function, backed by an in-memory Blobs store. Each device is a
// fresh copy of the store and sync modules with its own IndexedDB stand-in.
const env = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  requests: [] as { method: string; bytes: number }[],
}))

vi.mock('idb-keyval', () => ({
  get: async (k: string) => env.kv.get(k),
  set: async (k: string, v: unknown) => void env.kv.set(k, structuredClone(v)),
  update: async (k: string, f: (v: unknown) => unknown) => void env.kv.set(k, structuredClone(f(env.kv.get(k)))),
}))

vi.mock('@netlify/blobs', () => import('./fake-blobs'))

type Device = { kv: Map<string, unknown>; sync: typeof import('../src/lib/sync'); S: typeof import('../src/lib/store') }

async function device(): Promise<Device> {
  vi.resetModules()
  const kv = new Map<string, unknown>()
  env.kv = kv
  return { kv, sync: await import('../src/lib/sync'), S: await import('../src/lib/store') }
}

/** Run a sync as this device, a few minutes after the last one. */
async function on(d: Device, fn?: () => unknown) {
  vi.setSystemTime(Date.now() + 5 * 60 * 1000)
  env.kv = d.kv
  await fn?.()
  await d.sync.syncNow()
}

const CODE = 'ABCDE-FGHJK-MNPQR-STUVW'
const last = (pick: (r: { method: string; bytes: number }) => boolean) => env.requests.filter(pick).pop()
const changes = () => stores.get('vault-changes')?.size ?? 0

beforeAll(async () => {
  const { default: vault } = await import('../netlify/functions/vault.mts')
  const target = new EventTarget()
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
  Object.assign(globalThis, {
    window: target,
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    // Devices in one process must not hear each other's tabs.
    BroadcastChannel: undefined,
  })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const id = url.split('/').pop()!
    const req = new Request('http://local' + url, { method: init.method, headers: init.headers, body: init.body })
    env.requests.push({ method: init.method ?? 'GET', bytes: typeof init.body === 'string' ? init.body.length : 0 })
    return vault(req, { params: { id } } as never)
  })
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  stores.clear()
  env.requests.length = 0
})

describe('sync uploads changes, not the whole budget', () => {
  it('sends an edit as a small change and another device takes it in', async () => {
    const a = await device()
    a.S.commit({ notes: Array.from({ length: 200 }, (_, i) => ({ id: 'n' + i, u: 0, month: '2026-01', text: 'note number ' + i })) } as never)
    await on(a, () => a.sync.enableSync(CODE))
    const snapshot = env.requests.find((r) => r.method === 'PUT')!.bytes

    await on(a, () => a.S.updateSettings({ savingsTarget: 0.3 }))
    const change = last((r) => r.method === 'POST')!
    expect(change.bytes).toBeLessThan(snapshot / 10)
    expect(changes()).toBe(1)
    expect(a.sync.syncStatus().dirty).toBe(false)

    const b = await device()
    await on(b, () => b.sync.enableSync(CODE))
    expect(b.S.settings().savingsTarget).toBe(0.3)
    expect(Object.keys(b.S.getDB().notes)).toHaveLength(200)
    // Joining uploaded everything, which folded the change into the snapshot.
    expect(changes()).toBe(0)

    // B's next edit is a change again, and A takes it in without downloading the snapshot.
    await on(b, () => b.S.updateSettings({ savingsTarget: 0.4 }))
    expect(changes()).toBe(1)
    env.requests.length = 0
    await on(a)
    expect(a.S.settings().savingsTarget).toBe(0.4)
    expect(a.sync.syncStatus().dirty).toBe(false)
  })

  it('appends from two devices without either one retrying, and folds a long log into a snapshot', async () => {
    const a = await device()
    await on(a, () => a.sync.enableSync(CODE))
    const b = await device()
    await on(b, () => b.sync.enableSync(CODE))
    await on(a)

    // Both edit before either syncs: the second append doesn't conflict with the first.
    vi.setSystemTime(Date.now() + 5 * 60 * 1000)
    env.kv = a.kv
    a.S.updateSettings({ savingsTarget: 0.1 })
    env.kv = b.kv
    b.S.commit({ notes: [{ id: 'x', u: 0, month: '2026-02', text: 'from b' }] } as never)
    await on(a)
    await on(b)
    expect(env.requests.filter((r) => r.method === 'PUT')).toHaveLength(2) // only the two joins
    await on(a)
    expect(a.S.getDB().notes.x).toBeTruthy()
    expect(b.S.settings().savingsTarget).toBe(0.1)

    for (let i = 0; i < 35; i++) await on(a, () => a.S.updateSettings({ savingsTarget: i / 100 }))
    expect(changes()).toBeLessThan(31)
    expect(env.requests.filter((r) => r.method === 'PUT').length).toBeGreaterThan(2)
    await on(b)
    expect(b.S.settings().savingsTarget).toBe(0.34)
    expect(b.S.getDB().notes.x).toBeTruthy()
  })

  it('uploads everything again when the vault is gone', async () => {
    const a = await device()
    await on(a, () => a.sync.enableSync(CODE))
    stores.clear()
    await on(a, () => a.S.updateSettings({ savingsTarget: 0.2 }))
    expect(last((r) => r.method !== 'GET')!.method).toBe('PUT')
    const b = await device()
    await on(b, () => b.sync.enableSync(CODE))
    expect(b.S.settings().savingsTarget).toBe(0.2)
  })
})
