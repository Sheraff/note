import type { Server as HttpServer } from 'node:http'
import { parseArgs } from 'node:util'
import { createAdaptorServer } from '@hono/node-server'
import { createApp } from './app.ts'
import { registerDevFrontend, registerProdFrontend } from './frontend.ts'

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

const app = createApp()
const server = createAdaptorServer({ fetch: app.fetch }) as HttpServer

const isDev = parsed.values.dev
if (isDev) {
  await registerDevFrontend(app, server)
} else {
  await registerProdFrontend(app)
}

const port = Number(parsed.values.port ?? process.env.PORT ?? 5743)
server.listen(port, () => {
  console.log(`http://localhost:${port}`)
})
