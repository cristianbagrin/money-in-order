import { getStore } from '@netlify/blobs'
import type { Config, Context } from '@netlify/functions'

// One encrypted blob per sync code. The id is a hash of the code and the content is
// encrypted on the device, so this function only ever handles ciphertext.
//
// Every write gets a new revision id, stored in the blob's metadata and sent to clients as the
// ETag. A write must name the revision it was based on (If-Match), so two devices can never
// silently overwrite each other: the loser gets 412, pulls, merges and tries again.

const MAX_BYTES = 4 * 1024 * 1024

function store() {
  return getStore({ name: 'vaults', consistency: 'strong' })
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
    if (rev && req.headers.get('If-None-Match') === rev) {
      return new Response(null, { status: 304, headers: { ETag: rev, ...noStore } })
    }
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { ETag: rev, ...noStore } })
    const entry = await vaults.getWithMetadata(id)
    if (!entry) return new Response(null, { status: 404, headers: noStore })
    return new Response(entry.data, {
      status: 200,
      headers: { ETag: revOf(entry) ?? rev, 'Content-Type': 'text/plain', ...noStore },
    })
  }

  if (req.method === 'PUT') {
    const body = await req.text()
    if (!body.startsWith('v1.') || body.length > MAX_BYTES) return new Response('Bad payload', { status: 400 })
    const ifMatch = req.headers.get('If-Match')
    if (!ifMatch) return new Response('If-Match required', { status: 428 })
    const meta = await vaults.getMetadata(id)
    const current = meta ? revOf(meta) ?? '' : null
    const stale = ifMatch === 'new' ? current !== null : current !== ifMatch
    if (stale) return new Response('Changed elsewhere', { status: 412, headers: noStore })
    const rev = crypto.randomUUID()
    // Make the check-and-write atomic where the store gives us its own ETag.
    const guard = meta?.etag ? { onlyIfMatch: meta.etag } : meta ? {} : { onlyIfNew: true as const }
    const result = await vaults.set(id, body, { metadata: { rev }, ...guard })
    if (!result.modified) return new Response('Changed elsewhere', { status: 412, headers: noStore })
    return new Response(null, { status: 204, headers: { ETag: rev, ...noStore } })
  }

  if (req.method === 'DELETE') {
    await vaults.delete(id)
    return new Response(null, { status: 204 })
  }

  return new Response('Method not allowed', { status: 405 })
}

export const config: Config = {
  path: '/api/vault/:id',
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
}
