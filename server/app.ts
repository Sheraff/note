import { type HttpBindings } from '@hono/node-server'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import * as v from 'valibot'
import { authenticateRequest } from './auth.ts'
import { getCurrentSyncCursor, listFiles, listFilesSinceCursor } from './db.ts'
import {
  AuthRedirectResponseSchema,
  HealthResponseSchema,
  PushRequestSchema,
  SessionResponseSchema,
  SyncResponseSchema,
  SyncCursorSchema,
} from './schemas.ts'
import { applyChanges } from './sync.ts'

export type NoteApp = Hono<{
  Bindings: HttpBindings
  Variables: {
    currentUserId: string
  }
}>

export function createApp(): NoteApp {
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
