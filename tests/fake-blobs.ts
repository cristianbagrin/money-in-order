// An in-memory stand-in for @netlify/blobs, enough for the vault function: use with
// vi.mock('@netlify/blobs', () => import('./fake-blobs')).

type Entry = { data: string; metadata: Record<string, unknown>; etag: string }
// On globalThis, so a test that reloads its modules still talks to the same server.
const g = globalThis as { fakeBlobs?: Map<string, Map<string, Entry>> }
export const stores = (g.fakeBlobs ??= new Map())
let etags = 0

export function getStore({ name }: { name: string }) {
  if (!stores.has(name)) stores.set(name, new Map())
  const m = stores.get(name)!
  return {
    async getMetadata(key: string) {
      const e = m.get(key)
      return e ? { etag: e.etag, metadata: e.metadata } : null
    },
    async getWithMetadata(key: string) {
      return m.get(key) ?? null
    },
    async get(key: string) {
      return m.get(key)?.data ?? null
    },
    async set(key: string, data: string, opts: { metadata?: Record<string, unknown>; onlyIfMatch?: string; onlyIfNew?: boolean } = {}) {
      const e = m.get(key)
      if ((opts.onlyIfNew && e) || (opts.onlyIfMatch && e?.etag !== opts.onlyIfMatch)) return { modified: false }
      m.set(key, { data, metadata: opts.metadata ?? {}, etag: `${++etags}-${Math.random()}` })
      return { modified: true }
    },
    async delete(key: string) {
      m.delete(key)
    },
    async list({ prefix = '' }: { prefix?: string } = {}) {
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: m.get(key)!.etag })) }
    },
  }
}
