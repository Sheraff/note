import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createAdaptorServer, type HttpBindings } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import { Hono } from 'hono'
import type { ViteDevServer } from 'vite'
import * as v from 'valibot'
import { authenticateRequest } from './auth.ts'
import { getCurrentSyncCursor, listFiles, listFilesSinceCursor } from './db.ts'
import { sValidator } from '@hono/standard-validator'
import {
  AuthRedirectResponseSchema,
  HealthResponseSchema,
  PushRequestSchema,
  SessionResponseSchema,
  SyncResponseSchema,
  SyncCursorSchema,
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
let vite: ViteDevServer | undefined

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
}

export function createApp() {
  const app = new Hono<{
    Bindings: HttpBindings
    Variables: {
      currentUserId: string
    }
  }>()

  app.use('/api/sync/*', async (c, next) => {
    const auth = await authenticateRequest(c)

    if (!auth.authenticated) {
      return c.json(v.parse(AuthRedirectResponseSchema, { redirect: auth.redirect }), 401)
    }

    c.set('currentUserId', auth.user_id)
    await next()
  })

  app.get('/api/health', (c) => {
    return c.json(v.parse(HealthResponseSchema, { ok: true }))
  })

  app.get('/api/auth/session', async (c) => {
    const auth = await authenticateRequest(c)

    if (!auth.authenticated) {
      return c.json(v.parse(AuthRedirectResponseSchema, { redirect: auth.redirect }), 401)
    }

    return c.json(
      v.parse(SessionResponseSchema, {
        userId: auth.user_id,
      }),
    )
  })

  app.get('/api/sync/manifest', sValidator('query', v.object({ sinceCursor: v.pipe(v.string(), v.toNumber(), SyncCursorSchema) })), (c) => {
    const userId = c.get('currentUserId')
    const currentCursor = getCurrentSyncCursor()
    const sinceCursor = Math.min(c.req.valid('query').sinceCursor, currentCursor)

    return c.json(
      v.parse(SyncResponseSchema, {
        files: listFilesSinceCursor(userId, sinceCursor),
        conflicts: [],
        cursor: currentCursor,
      }),
    )
  })

  app.get('/api/sync/snapshot', (c) => {
    const userId = c.get('currentUserId')

    return c.json(
      v.parse(SyncResponseSchema, {
        files: listFiles(userId),
        conflicts: [],
        cursor: getCurrentSyncCursor(),
      }),
    )
  })

  app.post('/api/sync/push', sValidator('json', PushRequestSchema), async (c) => {
    const body = c.req.valid('json')
    const result = applyChanges(c.get('currentUserId'), body.changes, body.sinceCursor)

    return c.json(v.parse(SyncResponseSchema, result))
  })

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(error)
    return c.json({ error: message }, 500)
  })

  return app
}

if (isMainModule()) {
  const app = createApp()

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

  if (isDev) {
    const { createServer } = await import('vite')

    vite = await createServer({
      server: {
        middlewareMode: true,
      },
    })
  }

  const server = createAdaptorServer({ fetch: app.fetch })

  server.listen(port, () => {
    console.log(`http://localhost:${port}`)
  })
}
