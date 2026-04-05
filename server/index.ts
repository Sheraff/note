import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createAdaptorServer, type HttpBindings } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import { Hono } from 'hono'
import type { ViteDevServer } from 'vite'
import * as v from 'valibot'
import { getCurrentUser } from './auth.ts'
import { listFiles, listManifest } from './db.ts'
import {
  HealthResponseSchema,
  ManifestResponseSchema,
  PushRequestSchema,
  SyncResponseSchema,
} from './schemas.ts'
import { applyChanges } from './sync.ts'

const parsed = parseArgs({
  options: {
    dev: {
      type: 'boolean',
      default: false,
    },
    port: {
      type: 'string',
    },
  },
})

const isDev = parsed.values.dev
const port = Number(parsed.values.port ?? process.env.PORT ?? 5743)
const serverDir = fileURLToPath(new URL('.', import.meta.url))
const clientDistDir = isDev ? resolve(serverDir, '../dist/client') : resolve(serverDir, '../client')
const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const HTML_CACHE_CONTROL = 'no-cache'

export function createApp() {
  const app = new Hono<{ Bindings: HttpBindings }>()

  app.get('/api/health', (c) => {
    return c.json(v.parse(HealthResponseSchema, { ok: true }))
  })

  app.get('/api/sync/manifest', (c) => {
    const user = getCurrentUser()

    return c.json(
      v.parse(ManifestResponseSchema, {
        files: listManifest(user.id),
      }),
    )
  })

  app.get('/api/sync/snapshot', (c) => {
    const user = getCurrentUser()

    return c.json(
      v.parse(SyncResponseSchema, {
        files: listFiles(user.id),
        conflicts: [],
      }),
    )
  })

  app.post('/api/sync/push', async (c) => {
    const body = v.parse(PushRequestSchema, await c.req.json())
    const user = getCurrentUser()
    const result = applyChanges(user.id, body.changes)

    return c.json(v.parse(SyncResponseSchema, result))
  })

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(error)
    return c.json({ error: message }, 500)
  })

  return app
}

const app = createApp()
let vite: ViteDevServer | undefined

if (isDev) {
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api')) {
      await next()
      return
    }

    try {
      await new Promise<void>((resolveMiddleware, rejectMiddleware) => {
        vite?.middlewares(c.env.incoming, c.env.outgoing, (error?: Error) => {
          if (error) {
            rejectMiddleware(error)
            return
          }

          resolveMiddleware()
        })
      })

      return RESPONSE_ALREADY_SENT
    } catch (error) {
      if (error instanceof Error) {
        vite?.ssrFixStacktrace(error)
        return c.text(error.stack ?? error.message, 500)
      }

      return c.text('Unknown error', 500)
    }
  })
} else {
  app.use(
    '*',
    serveStatic({
      root: clientDistDir,
      onFound(_, c) {
        if (c.req.path.startsWith('/assets/')) {
          c.header('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL)
          return
        }

        c.header('Cache-Control', HTML_CACHE_CONTROL)
      },
    }),
  )

  const indexHtml = await readFile(resolve(clientDistDir, 'index.html'), 'utf8')

  app.get('*', (c) => {
    if (c.req.path.includes('.')) {
      return c.notFound()
    }

    c.header('Cache-Control', HTML_CACHE_CONTROL)
    return c.html(indexHtml)
  })
}

const server = createAdaptorServer({ fetch: app.fetch })

if (isDev) {
  const { createServer } = await import('vite')

  vite = await createServer({
    server: {
      middlewareMode: true,
    },
  })
}

server.listen(port, () => {
  console.log(`http://localhost:${port}`)
})
