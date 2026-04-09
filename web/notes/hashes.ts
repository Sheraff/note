function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function hashBytes(source: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', source)
  const digestBytes = new Uint8Array(digest)

  return toHex(digestBytes)
}

export async function hashText(content: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(content))
}

// TODO: why 2 exports with the same name?
export const hashContent = hashText
