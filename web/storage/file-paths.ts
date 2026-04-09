const IMAGE_PATH_SUFFIXES = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp'])
const IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/tiff',
  'image/webp',
  'image/x-icon',
])
const MIME_TYPE_HINTS_BY_SUFFIX = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'application/javascript'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.mjs', 'application/javascript'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.toml', 'application/toml'],
  ['.ts', 'application/typescript'],
  ['.tsx', 'application/typescript'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.xml', 'application/xml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
])

function getPathBaseName(path: string): string {
  const lastSlashIndex = path.lastIndexOf('/')
  return lastSlashIndex >= 0 ? path.slice(lastSlashIndex + 1) : path
}

function getPathSuffixes(path: string): string[] {
  const fileName = getPathBaseName(path).toLowerCase()
  const suffixes: string[] = []
  let dotIndex = fileName.indexOf('.')

  while (dotIndex >= 0 && dotIndex < fileName.length - 1) {
    suffixes.push(fileName.slice(dotIndex))
    dotIndex = fileName.indexOf('.', dotIndex + 1)
  }

  return suffixes
}

export function normalizeMimeType(mimeType: string | null | undefined): string | null {
  if (mimeType == null) {
    return null
  }

  const [type] = mimeType.split(';', 1)
  const normalized = type?.trim().toLowerCase() ?? ''
  return normalized.length === 0 ? null : normalized
}

export function getMimeTypeHintFromPath(path: string): string | null {
  for (const suffix of getPathSuffixes(path)) {
    const mimeType = MIME_TYPE_HINTS_BY_SUFFIX.get(suffix)

    if (mimeType !== undefined) {
      return mimeType
    }
  }

  return null
}

export function isImagePath(path: string, mimeType?: string | null): boolean {
  const normalizedMimeType = normalizeMimeType(mimeType)

  if (normalizedMimeType !== null) {
    return IMAGE_MIME_TYPES.has(normalizedMimeType) || normalizedMimeType.startsWith('image/')
  }

  return getPathSuffixes(path).some((suffix) => IMAGE_PATH_SUFFIXES.has(suffix))
}

export function getFileTypeLabel(path: string, mimeType?: string | null): string {
  const longestSuffix = getPathSuffixes(path)[0]

  if (longestSuffix !== undefined) {
    return longestSuffix.slice(1)
  }

  const normalizedMimeType = normalizeMimeType(mimeType)

  if (normalizedMimeType !== null) {
    return normalizedMimeType
  }

  return 'file'
}
