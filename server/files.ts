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

export function comparePaths(left: string, right: string): number {
  return left.localeCompare(right)
}
