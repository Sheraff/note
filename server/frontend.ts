import { readFile } from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import type { ViteDevServer } from 'vite'
import type { NoteApp } from './app.ts'

const serverDir = fileURLToPath(new URL('.', import.meta.url))
const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const HTML_CACHE_CONTROL = 'no-cache'

export async function registerDevFrontend(app: NoteApp, server: HttpServer): Promise<void> {
  let vite: ViteDevServer | undefined

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

  const { createServer } = await import('vite')

  vite = await createServer({
    server: {
      middlewareMode: true,
      hmr: {
        server,
      },
    },
  })
}

export async function registerProdFrontend(app: NoteApp): Promise<void> {
  const clientDistDir = resolve(serverDir, '../client')

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
