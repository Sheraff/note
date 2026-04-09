import { hashBytes, hashText } from '../notes/hashes.ts'
import { getMimeTypeHintFromPath, isImagePath, normalizeMimeType } from './file-paths.ts'
import { createStoredBinaryFile, createStoredTextFile, type StoredFile, type StoredFileViewKind } from './types.ts'

const MAX_ALLOWED_SUSPICIOUS_TEXT_CHARACTER_RATIO = 0.02
const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf] as const

function hasUtf8Bom(content: Uint8Array): boolean {
  return UTF8_BOM_BYTES.every((byte, index) => content[index] === byte)
}

function isSuspiciousTextCodePoint(codePoint: number): boolean {
  return (
    ((codePoint >= 0x00 && codePoint < 0x20) && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0c && codePoint !== 0x0d) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  )
}

function hasTooManySuspiciousTextCharacters(content: string): boolean {
  if (content.length === 0) {
    return false
  }

  let suspiciousCharacterCount = 0
  const maxAllowedSuspiciousCharacterCount = Math.max(
    1,
    Math.floor(content.length * MAX_ALLOWED_SUSPICIOUS_TEXT_CHARACTER_RATIO),
  )

  for (const character of content) {
    const codePoint = character.codePointAt(0)

    if (codePoint === undefined || !isSuspiciousTextCodePoint(codePoint)) {
      continue
    }

    suspiciousCharacterCount += 1

    if (suspiciousCharacterCount > maxAllowedSuspiciousCharacterCount) {
      return true
    }
  }

  return false
}

export function decodeUtf8TextContent(content: Uint8Array): string | null {
  if (content.byteLength === 0) {
    return ''
  }

  for (const byte of content) {
    if (byte === 0) {
      return null
    }
  }

  // Normalize UTF-8 text to a BOM-free string so editing and hashing stay consistent.
  const normalizedContent = hasUtf8Bom(content) ? content.subarray(UTF8_BOM_BYTES.length) : content

  let decoded: string

  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(normalizedContent)
  } catch {
    return null
  }

  return hasTooManySuspiciousTextCharacters(decoded) ? null : decoded
}

export async function createStoredFileFromFile(path: string, file: File): Promise<StoredFile> {
  const mimeType = normalizeMimeType(file.type) ?? getMimeTypeHintFromPath(path)
  const content = new Uint8Array(await file.arrayBuffer())

  if (isImagePath(path, mimeType)) {
    return createStoredBinaryFile({
      path,
      content,
      contentHash: await hashBytes(content),
      updatedAt: new Date(file.lastModified).toISOString(),
      size: file.size,
      mimeType,
    })
  }

  const textContent = decodeUtf8TextContent(content)

  if (textContent !== null) {
    return createStoredTextFile({
      path,
      content: textContent,
      contentHash: await hashText(textContent),
      updatedAt: new Date(file.lastModified).toISOString(),
      size: file.size,
      mimeType,
    })
  }

  return createStoredBinaryFile({
    path,
    content,
    contentHash: await hashBytes(content),
    updatedAt: new Date(file.lastModified).toISOString(),
    size: file.size,
    mimeType,
  })
}

export function getStoredFileViewKind(file: StoredFile): StoredFileViewKind {
  if (isImagePath(file.path, file.mimeType)) {
    return 'image'
  }

  return file.format === 'binary' ? 'attachment' : 'text'
}
