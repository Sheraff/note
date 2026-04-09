import { createHash } from 'node:crypto'
import { type HttpBindings } from '@hono/node-server'
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import * as v from 'valibot'
import { authenticateRequest } from './auth.ts'
import { getBlob, getCurrentSyncCursor, listFiles, listFilesSinceCursor, upsertBlob, userHasBlob } from './db.ts'
import {
  AuthRedirectResponseSchema,
  ContentHashSchema,
  HealthResponseSchema,
  PushRequestSchema,
  SessionResponseSchema,
  SyncResponseSchema,
  SyncCursorSchema,
} from './schemas.ts'
import { applyChanges } from './sync.ts'

const BlobHashParamSchema = v.object({
  hash: ContentHashSchema,
})

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

  app.use('/api/blobs/*', async (c, next) => {
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

  app.get('/api/blobs/:hash', sValidator('param', BlobHashParamSchema), (c) => {
    const hash = c.req.valid('param').hash

    if (!userHasBlob(c.get('currentUserId'), hash)) {
      return c.body(null, 404)
    }

    const blob = getBlob(hash)

    if (blob === null) {
      return c.body(null, 404)
    }

    return new Response(Buffer.from(blob.content), {
      status: 200,
      headers: {
        'Content-Length': String(blob.size),
        'Content-Type': 'application/octet-stream',
      },
    })
  })

  app.put('/api/blobs/:hash', sValidator('param', BlobHashParamSchema), async (c) => {
    const hash = c.req.valid('param').hash
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const computedHash = createHash('sha256').update(bytes).digest('hex')

    if (computedHash !== hash) {
      return c.json({ error: 'Blob hash mismatch' }, 400)
    }

    upsertBlob(hash, bytes)
    return c.body(null, 204)
  })

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(error)
    return c.json({ error: message }, 500)
  })

  return app
}
