export type User = {
  id: string
}

const TEST_USER_HEADER = 'x-note-user'

const STATIC_USER: User = {
  id: 'demo-user',
}

export function getCurrentUser(request?: Request): User {
  const userId = request?.headers.get(TEST_USER_HEADER)?.trim()

  if (userId !== undefined && userId.length > 0) {
    return { id: userId }
  }

  return STATIC_USER
}
