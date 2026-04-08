import { createSsoClient, type AuthCheck, type SsoClient, COOKIE_NAME } from '@sso/client'
import { getCookie } from 'hono/cookie'
import type { Context } from 'hono'

const DEVELOPMENT_USER_ID = 'test'
const PRODUCTION_HOST = 'note.florianpellet.com'
const TEST_USER_HEADER = 'x-note-user'

let ssoClient: SsoClient | null = null

function getDevelopmentUserId(request?: Request): string {
  const userId = request?.headers.get(TEST_USER_HEADER)?.trim()

  if (userId !== undefined && userId.length > 0) {
    return userId
  }

  return DEVELOPMENT_USER_ID
}

export async function authenticateRequest(c: Context): Promise<AuthCheck.Result['message']> {
  const request = c.req.raw

  if (process.env.NODE_ENV !== 'production') {
    return {
      authenticated: true,
      user_id: getDevelopmentUserId(request),
    }
  }

  ssoClient ??= createSsoClient('note')

  return ssoClient.checkAuth(
    getCookie(c, COOKIE_NAME),
    PRODUCTION_HOST,
    request.url,
    request.signal,
  )
}
