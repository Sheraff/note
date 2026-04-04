import * as v from 'valibot'
import {
  HealthResponseSchema,
  PushRequestSchema,
  SyncResponseSchema,
  type PushRequest,
} from '../server/schemas.ts'

async function parseJsonResponse<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  response: Response,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> {
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
    async getSnapshot() {
      return parseJsonResponse(await fetch(`${baseUrl}/api/sync/snapshot`), SyncResponseSchema)
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
