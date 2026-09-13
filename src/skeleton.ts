import { embeddedFiles } from 'bun'
// Bun 1.3.11 has no `bun build --compile --asset <dir>` flag (see
// docs/decisions/0001-bun-version.md), so assets are embedded through the
// generated ASSET_PATHS manifest (scripts/gen-assets.ts) instead of being
// auto-discovered from `embeddedFiles` by name. `embeddedFiles.length` is
// still the packaging assertion's evidence that DCE didn't drop anything.
import { ASSET_PATHS } from './generated-assets'

const ASSETS = new Map<string, Blob>()
for (const [urlPath, diskPath] of Object.entries(ASSET_PATHS)) ASSETS.set(urlPath, Bun.file(diskPath))

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 7373,
  development: false,
  error: () => new Response('error', { status: 500 }),
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/__embedded') return new Response(String(embeddedFiles.length))

    const hit = ASSETS.get(path) ?? (path === '/' ? ASSETS.get('/index.html') : undefined)
    if (!hit) return new Response('not found', { status: 404 })
    return new Response(hit, { headers: { 'content-type': hit.type } })
  },
})

console.log(`skeleton on ${server.url}`)
