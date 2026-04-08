import { afterEach, describe, expect, it, vi } from 'vitest'

const { checkAuthMock, createSsoClientMock } = vi.hoisted(() => {
  const checkAuthMock = vi.fn()

  return {
    checkAuthMock,
    createSsoClientMock: vi.fn(() => ({
      checkAuth: checkAuthMock,
      disconnect: vi.fn(),
      getInvitationCode: vi.fn(),
    })),
  }
})

vi.mock('@sso/client', () => ({
  COOKIE_NAME: 'sso_session',
  createSsoClient: createSsoClientMock,
}))

const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv
  vi.clearAllMocks()
  vi.resetModules()
})

describe('server auth middleware', () => {
  it('returns the current user id for authenticated API requests', async () => {
    process.env.NODE_ENV = 'development'

    const { createApp } = await import('../server/app.ts')
    const response = await createApp().fetch(
      new Request('http://localhost/api/auth/session', {
        headers: {
          'X-Note-User': 'api-user',
        },
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ userId: 'api-user' })
    expect(createSsoClientMock).not.toHaveBeenCalled()
  })

  it('returns a redirect payload for unauthenticated API requests in production', async () => {
    process.env.NODE_ENV = 'production'
    checkAuthMock.mockResolvedValue({
      authenticated: false,
      redirect: 'https://sso.example.test',
    })

    const { createApp } = await import('../server/app.ts')
    const response = await createApp().fetch(new Request('https://note.florianpellet.com/api/auth/session'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ redirect: 'https://sso.example.test' })
  })

  it('checks SSO in production with the fixed host and request path', async () => {
    process.env.NODE_ENV = 'production'
    checkAuthMock.mockResolvedValue({
      authenticated: true,
      user_id: 'sso-user',
    })

    const { createApp } = await import('../server/app.ts')
    const request = new Request('https://note.florianpellet.com/api/auth/session?view=full', {
      headers: {
        cookie: 'other=value; sso_session=session-token',
      },
    })
    const response = await createApp().fetch(request)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ userId: 'sso-user' })
    expect(createSsoClientMock).toHaveBeenCalledWith('note')
    expect(checkAuthMock).toHaveBeenCalledWith(
      'session-token',
      'note.florianpellet.com',
      '/api/auth/session',
      request.signal,
    )
  })

})
