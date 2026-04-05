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

export function createConflictCopyPath(path: string, timestamp: string, attempt = 0): string {
  const normalizedPath = normalizeNotePath(path)
  const separatorIndex = normalizedPath.lastIndexOf('/')
  const directory = separatorIndex >= 0 ? normalizedPath.slice(0, separatorIndex) : ''
  const fileName = separatorIndex >= 0 ? normalizedPath.slice(separatorIndex + 1) : normalizedPath
  const extensionIndex = fileName.lastIndexOf('.')
  const baseName = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : ''
  const safeTimestamp = timestamp.replaceAll(':', '-').replaceAll('.', '-')
  const suffix = attempt === 0 ? '' : `.${attempt + 1}`
  const conflictName = `${baseName}.conflict-${safeTimestamp}${suffix}${extension}`

  return directory.length > 0 ? `${directory}/${conflictName}` : conflictName
}

export function ensureMarkdownExtension(path: string): string {
  const normalized = normalizeNotePath(path)

  if (normalized.endsWith('.md')) {
    return normalized
  }

  return `${normalized}.md`
}

export function normalizeRelativeCreatePath(input: string): string {
  const trimmed = input.trim()

  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.startsWith('~')) {
    return ''
  }

  if (/^[A-Za-z]:([\\/]|$)/.test(trimmed)) {
    return ''
  }

  const normalized = normalizeNotePath(trimmed)

  if (normalized.length === 0 || normalized.split('/').some((segment) => segment === '~')) {
    return ''
  }

  return normalized
}

export function normalizeEntryName(input: string): string {
  const trimmed = input.trim()

  if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') {
    return ''
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return ''
  }

  return trimmed
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
