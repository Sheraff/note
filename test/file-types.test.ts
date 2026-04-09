import { describe, expect, it } from 'vitest'
import { hashContent } from '../web/notes/hashes.ts'
import { createStoredFileFromFile, decodeUtf8TextContent, getStoredFileViewKind } from '../web/storage/file-classify.ts'
import { getFileTypeLabel, getMimeTypeHintFromPath } from '../web/storage/file-paths.ts'

describe('file type helpers', () => {
  it('uses dotfile-aware suffix labels', () => {
    expect(getFileTypeLabel('notes/.env')).toBe('env')
    expect(getFileTypeLabel('notes/.env.example')).toBe('env.example')
    expect(getFileTypeLabel('notes/archive.tar.gz')).toBe('tar.gz')
  })

  it('uses suffix-aware mime hints for dotfiles', () => {
    expect(getMimeTypeHintFromPath('notes/.svg')).toBe('image/svg+xml')
    expect(getMimeTypeHintFromPath('notes/.config.yaml')).toBe('application/yaml')
  })

  it('normalizes a utf-8 bom into plain text content', () => {
    const content = Uint8Array.from([0xef, 0xbb, 0xbf, 0x48, 0x69])

    expect(decodeUtf8TextContent(content)).toBe('Hi')
  })

  it('rejects binary-looking content during utf-8 decoding', () => {
    const content = Uint8Array.from([0x48, 0x00, 0x69])

    expect(decodeUtf8TextContent(content)).toBeNull()
  })

  it('classifies utf-8 bom files as normalized text', async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b])
    const file = new File([bytes], '.env', { lastModified: 0 })
    const storedFile = await createStoredFileFromFile('notes/.env', file)

    expect(storedFile).toMatchObject({
      path: 'notes/.env',
      format: 'text',
      content: 'ok',
      size: bytes.byteLength,
    })
    expect(storedFile.contentHash).toBe(await hashContent('ok'))
    expect(getStoredFileViewKind(storedFile)).toBe('text')
  })

  it('keeps svg files in image view', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
    const file = new File([svg], 'pixel.svg', {
      type: 'image/svg+xml; charset=utf-8',
      lastModified: 0,
    })
    const storedFile = await createStoredFileFromFile('notes/pixel.svg', file)

    expect(storedFile).toMatchObject({
      path: 'notes/pixel.svg',
      format: 'binary',
      mimeType: 'image/svg+xml',
    })
    expect(getStoredFileViewKind(storedFile)).toBe('image')
  })
})
