// Local stand-in for Netlify: serves dist/ plus the sync function, backed by a local Blobs server.
// Usage: npm run build && node --experimental-strip-types scripts/local-server.mjs <blobs-dir>
// Then open http://localhost:4174 (sync works between browsers/tabs).
import { BlobsServer } from '@netlify/blobs/server'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const blobsDir = process.argv[2] ?? '.local-blobs'
const PORT = Number(process.env.PORT ?? 4174)
const BLOBS_PORT = Number(process.env.BLOBS_PORT ?? 8971)
const blobs = new BlobsServer({ directory: blobsDir, port: BLOBS_PORT, token: 'tok' })
await blobs.start()
globalThis.netlifyBlobsContext = Buffer.from(
  JSON.stringify({ edgeURL: `http://localhost:${BLOBS_PORT}`, uncachedEdgeURL: `http://localhost:${BLOBS_PORT}`, token: 'tok', siteID: 'site' }),
).toString('base64')
const { default: vault } = await import('../netlify/functions/vault.mts')
const { default: account } = await import('../netlify/functions/account.mts')
const dist = path.resolve('dist')
// Same security headers as netlify.toml, so problems show up locally first.
const HEADERS = {
  'Content-Security-Policy': CSP(),
}
function CSP() {
  return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net https://latest.currency-api.pages.dev; manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
}
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:4174')
    const m = url.pathname.match(/^\/api\/(vault|account)\/([^/]+)$/)
    if (m) {
      const handler = m[1] === 'vault' ? vault : account
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
      const r = await handler(new Request(url, { method: req.method, headers: req.headers, body }), { params: { id: m[2] } })
      res.writeHead(r.status, Object.fromEntries(r.headers))
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await r.arrayBuffer()))
      return
    }
    let file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
    try {
      const data = await readFile(file)
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', ...HEADERS })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  .listen(PORT, () => console.log(`dev server on ${PORT}`))
