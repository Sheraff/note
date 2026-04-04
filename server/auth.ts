export type User = {
  id: string
}

const STATIC_USER: User = {
  id: 'demo-user',
}

export function getCurrentUser(): User {
  return STATIC_USER
}
