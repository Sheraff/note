import * as v from 'valibot'
import {
  AuthRedirectResponseSchema,
  HealthResponseSchema,
  PushRequestSchema,
  SessionResponseSchema,
  SyncResponseSchema,
  type PushRequest,
} from '#server/schemas.ts'

export class AuthRedirectError extends Error {
  readonly redirect: string | null

  constructor(redirect: string | null) {
    super('Authentication required')
    this.name = 'AuthRedirectError'
    this.redirect = redirect
  }
}

export function isAuthRedirectError(error: unknown): error is AuthRedirectError {
  return error instanceof AuthRedirectError
}

async function handleAuthRedirect(response: Response): Promise<never> {
  let redirect: string | null = null

  try {
    redirect = v.parse(AuthRedirectResponseSchema, await response.json()).redirect
  } catch {
    redirect = null
  }

  if (redirect !== null && typeof window !== 'undefined') {
    window.location.assign(redirect)
  }

  throw new AuthRedirectError(redirect)
}

async function parseJsonResponse<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  response: Response,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> {
  if (response.status === 401) {
    return handleAuthRedirect(response)
  }

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`)
  }

  return v.parse(schema, await response.json())
}

export function createApiClient(baseUrl = '') {
  return {
    async getHealth() {
      return parseJsonResponse(await fetch(`${baseUrl}/api/health`), HealthResponseSchema)
    },
    async getSession() {
      return parseJsonResponse(await fetch(`${baseUrl}/api/auth/session`), SessionResponseSchema)
    },
    async getSnapshot() {
      return parseJsonResponse(await fetch(`${baseUrl}/api/sync/snapshot`), SyncResponseSchema)
    },
    async getRemoteChanges(sinceCursor: number) {
      return parseJsonResponse(await fetch(`${baseUrl}/api/sync/manifest?sinceCursor=${sinceCursor}`), SyncResponseSchema)
    },
    async pushChanges(payload: PushRequest) {
      const body = v.parse(PushRequestSchema, payload)

      return parseJsonResponse(
        await fetch(`${baseUrl}/api/sync/push`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
        SyncResponseSchema,
      )
    },
  }
}
