import { getStore } from '@netlify/blobs'
import type { Config, Context } from '@netlify/functions'

// One encrypted snapshot per sync code. The id is a hash of the code and the content is
// encrypted on the device, so this function only ever handles ciphertext.
//
// Every write gets a new revision id, stored in the blob's metadata and returned as X-Rev.
// A write must name the revision it was based on (X-Base-Rev), so two devices can never
// silently overwrite each other: the loser gets 412, pulls, merges and tries again.
// (Custom headers, because Netlify's edge consumes the standard If-Match / If-None-Match / ETag.)
//
// Next to that snapshot, a vault keeps a short log of changes: each one an encrypted set of the
// records a device changed since its last upload (POST). Records merge commutatively and idempotently,
// so changes need no revision check: the vault's data is the snapshot merged with every change, in any
// order. A device now and then writes the whole merged budget as a new snapshot (PUT) and names the
// changes it folded in (X-Covers); only those are dropped, so a change appended meanwhile survives.
// Clients that send X-Sync: 2 get the snapshot and changes they lack in one JSON reply; older clients
// keep getting the bare snapshot.

const MAX_BYTES = 4 * 1024 * 1024
/** A client that never folds changes into a snapshot is asked to (409) once this many are waiting. */
const MAX_CHANGES = 100
const CHANGE_ID = /^[0-9a-f]{16}$/

function store() {
  return getStore({ name: 'vaults', consistency: 'strong' })
}

function changeStore() {
  return getStore({ name: 'vault-changes', consistency: 'strong' })
}

async function changeIds(id: string): Promise<string[]> {
  const { blobs } = await changeStore().list({ prefix: id + '/' })
  return blobs.map((b) => b.key.slice(id.length + 1))
}

/** Change ids from a comma-separated header (anything malformed is ignored). */
function idList(header: string | null): string[] {
  return (header ?? '').split(',').filter((c) => CHANGE_ID.test(c))
}

function revOf(meta: { metadata?: Record<string, unknown> } | null): string | null {
  const rev = meta?.metadata?.rev
  return typeof rev === 'string' ? rev : null
}

const noStore = { 'Cache-Control': 'no-store' }

export default async (req: Request, context: Context) => {
  const id = context.params.id ?? ''
  if (!/^[0-9a-f]{64}$/.test(id)) return new Response('Bad id', { status: 400 })
  const vaults = store()

  if (req.method === 'GET' || req.method === 'HEAD') {
    const meta = await vaults.getMetadata(id)
    if (!meta) return new Response(null, { status: 404, headers: noStore })
    const rev = revOf(meta) ?? ''
    if (req.method === 'GET' && req.headers.get('X-Sync') === '2') {
      // Everything the client lacks: the snapshot when it changed, and the changes it hasn't got.
      const changes = await changeIds(id)
      const have = new Set(idList(req.headers.get('X-Have')))
      let snap: string | undefined
      let snapRev = rev
      if (!rev || req.headers.get('X-Have-Rev') !== rev) {
        const entry = await vaults.getWithMetadata(id, { type: 'text' })
        if (!entry) return new Response(null, { status: 404, headers: noStore })
        snap = entry.data
        snapRev = revOf(entry) ?? rev
      }
      const log = changeStore()
      const add = (
        await Promise.all(changes.filter((c) => !have.has(c)).map(async (c) => [c, await log.get(`${id}/${c}`, { type: 'text' })] as const))
      ).filter((e): e is readonly [string, string] => typeof e[1] === 'string')
      const body = JSON.stringify({ rev: snapRev, changes, snap, add })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', ...noStore } })
    }
    if (rev && req.headers.get('X-Have-Rev') === rev) {
      return new Response(null, { status: 204, headers: { 'X-Rev': rev, ...noStore } })
    }
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { 'X-Rev': rev, ...noStore } })
    const entry = await vaults.getWithMetadata(id)
    if (!entry) return new Response(null, { status: 404, headers: noStore })
    return new Response(entry.data, {
      status: 200,
      headers: { 'X-Rev': revOf(entry) ?? rev, 'Content-Type': 'text/plain', ...noStore },
    })
  }

  if (req.method === 'PUT') {
    const body = await req.text()
    if (!body.startsWith('v1.') || body.length > MAX_BYTES) return new Response('Bad payload', { status: 400 })
    const base = req.headers.get('X-Base-Rev')
    if (!base) return new Response('X-Base-Rev required', { status: 428 })
    const meta = await vaults.getMetadata(id)
    const current = meta ? revOf(meta) ?? '' : null
    const stale = base === 'new' ? current !== null : current !== base
    if (stale) return new Response('Changed elsewhere', { status: 412, headers: noStore })
    const rev = crypto.randomUUID()
    // Make the check-and-write atomic where the store gives us its own ETag.
    const guard = meta?.etag ? { onlyIfMatch: meta.etag } : meta ? {} : { onlyIfNew: true as const }
    const result = await vaults.set(id, body, { metadata: { rev }, ...guard })
    if (!result.modified) return new Response('Changed elsewhere', { status: 412, headers: noStore })
    // The snapshot holds these changes now. (If a delete fails, the change is merged again: harmless.)
    const log = changeStore()
    await Promise.allSettled(idList(req.headers.get('X-Covers')).map((c) => log.delete(`${id}/${c}`)))
    return new Response(null, { status: 201, headers: { 'X-Rev': rev, ...noStore } })
  }

  if (req.method === 'POST') {
    const body = await req.text()
    if (!body.startsWith('v1.') || body.length > MAX_BYTES) return new Response('Bad payload', { status: 400 })
    // Changes only go on top of a snapshot: without one the client uploads everything instead.
    if (!(await vaults.getMetadata(id))) return new Response(null, { status: 404, headers: noStore })
    if ((await changeIds(id)).length >= MAX_CHANGES) return new Response('Too many changes', { status: 409, headers: noStore })
    const change = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    await changeStore().set(`${id}/${change}`, body)
    return new Response(null, { status: 201, headers: { 'X-Change': change, ...noStore } })
  }

  if (req.method === 'DELETE') {
    const log = changeStore()
    await Promise.allSettled((await changeIds(id)).map((c) => log.delete(`${id}/${c}`)))
    await vaults.delete(id)
    return new Response(null, { status: 204 })
  }

  return new Response('Method not allowed', { status: 405 })
}

export const config: Config = {
  path: '/api/vault/:id',
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
}
