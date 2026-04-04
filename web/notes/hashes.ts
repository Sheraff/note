export async function hashContent(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  const bytes = new Uint8Array(digest)

  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}
