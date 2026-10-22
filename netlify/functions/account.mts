import { getStore } from '@netlify/blobs'
import type { Config, Context } from '@netlify/functions'

// Which emails have an account, so one email can't end up with two budgets and a sign-in can say
// "wrong password" rather than "no account". The id is a hash of the email made on the device: this
// function never sees an email, a password or any data.

function store() {
  return getStore({ name: 'accounts', consistency: 'strong' })
}

const noStore = { 'Cache-Control': 'no-store' }

export default async (req: Request, context: Context) => {
  const id = context.params.id ?? ''
  if (!/^[0-9a-f]{64}$/.test(id)) return new Response('Bad id', { status: 400 })
  const accounts = store()

  if (req.method === 'GET' || req.method === 'HEAD') {
    const meta = await accounts.getMetadata(id)
    return new Response(null, { status: meta ? 200 : 404, headers: noStore })
  }

  if (req.method === 'PUT') {
    const result = await accounts.set(id, '1', { onlyIfNew: true })
    return new Response(null, { status: result.modified ? 201 : 409, headers: noStore })
  }

  return new Response('Method not allowed', { status: 405 })
}

export const config: Config = {
  path: '/api/account/:id',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
}
