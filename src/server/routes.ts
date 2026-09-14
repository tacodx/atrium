import { dispatch } from '../core/actions'
import type { Registry } from '../core/registry'

export interface RouteCtx {
  registry: Registry
  snapshot(): Record<string, unknown>
  /** Supplies a `call` action's `cfg` argument. See scheduler.configFor. */
  configFor(providerId: string): unknown
  headers: Record<string, string>
}

const ACTION_RE = /^\/api\/actions\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/

// Populated lazily from the generated asset manifest (scripts/gen-assets.ts
// writes src/generated-assets.ts, keyed by each file's ORIGINAL dist-relative
// URL path — Bun.embeddedFiles[i].name flattens and re-hashes subdirectory
// assets under --compile, so routing must come from this manifest, never from
// embeddedFiles). The import is dynamic, not static, on purpose: that
// generated file is gitignored and does not exist until `bun run build:web &&
// bun run gen:assets` has run, and this module is reachable from
// `bun test`/a plain `bun run` against source with no build step at all — a
// static import would make every unit test fail to even load. `bun build
// --compile` bundles a single output file with no code-splitting, so the
// dynamic import's own nested static `with { type: 'file' }` imports are
// still embedded; verified end to end by the packaging assertion
// (scripts/assert-package.ts), which is the one place this actually has to
// serve real content.
let assetsPromise: Promise<Map<string, Blob>> | undefined

function loadAssets(): Promise<Map<string, Blob>> {
  if (!assetsPromise) {
    assetsPromise = import('../generated-assets')
      .then(({ ASSET_PATHS }) => {
        const m = new Map<string, Blob>()
        for (const [urlPath, diskPath] of Object.entries(ASSET_PATHS)) m.set(urlPath, Bun.file(diskPath))
        return m
      })
      .catch(() => new Map<string, Blob>())   // no build yet (dev/test) — serve nothing, don't crash
  }
  return assetsPromise
}

/**
 * PRE-AUTH by design: the page itself must load before any token exists,
 * because the handoff token arrives in the URL fragment and is read by the
 * page's own JavaScript. Callers still run this behind the Host/Origin gate
 * (checkRequest) — it is unauthenticated, not ungated.
 *
 * Manifest-only: the only paths ever served are exactly the keys baked into
 * ASSET_PATHS at build time from the real dist tree. A request path is never
 * mapped onto the filesystem — an unauthenticated arbitrary-file-read would be
 * far worse than the problem this solves.
 */
export async function serveAsset(path: string, headers: Record<string, string>): Promise<Response | undefined> {
  const assets = await loadAssets()
  const hit = assets.get(path) ?? (path === '/' ? assets.get('/index.html') : undefined)
  if (!hit) return undefined
  return new Response(hit, { headers: { ...headers, 'content-type': hit.type } })
}

/** Called ONLY after the gate and the bearer check have both passed. */
export async function handleRoute(req: Request, ctx: RouteCtx): Promise<Response> {
  const path = new URL(req.url).pathname

  if (path === '/api/state' && req.method === 'GET') {
    return Response.json(ctx.snapshot(), { headers: ctx.headers })
  }

  const m = ACTION_RE.exec(path)
  if (m && req.method === 'POST') {
    const [, providerId, actionId] = m
    try {
      await dispatch(ctx.registry, providerId!, actionId!, await req.json(), {
        cfg: ctx.configFor(providerId!),
      })
      return Response.json({ ok: true }, { headers: ctx.headers })
    } catch (e) {
      // Unknown provider/action and payload-validation failures are client
      // errors, not server errors. The message is safe: it echoes only the
      // ids the client already sent.
      return Response.json({ ok: false, error: (e as Error).message }, { status: 400, headers: ctx.headers })
    }
  }

  return new Response('not found', { status: 404, headers: ctx.headers })
}
