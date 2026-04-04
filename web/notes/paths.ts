const WINDOWS_PATH_SEPARATOR = /\\/g

export function normalizeNotePath(input: string): string {
  const normalized = input.replace(WINDOWS_PATH_SEPARATOR, '/').trim()
  const segments = normalized
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  if (segments.length === 0) {
    return ''
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return ''
    }
  }

  return segments.join('/')
}

export function ensureMarkdownExtension(path: string): string {
  const normalized = normalizeNotePath(path)

  if (normalized.endsWith('.md')) {
    return normalized
  }

  return `${normalized}.md`
}

export function getParentPath(path: string): string | null {
  const normalized = normalizeNotePath(path)
  const separatorIndex = normalized.lastIndexOf('/')

  if (separatorIndex < 0) {
    return null
  }

  return normalized.slice(0, separatorIndex)
}

export function getName(path: string): string {
  const normalized = normalizeNotePath(path)
  const separatorIndex = normalized.lastIndexOf('/')

  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized
}

export function joinNotePath(parent: string | null, name: string): string {
  const normalizedName = normalizeNotePath(name)

  if (parent === null || parent.length === 0) {
    return normalizedName
  }

  return normalizeNotePath(`${parent}/${normalizedName}`)
}
