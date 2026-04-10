import { getMimeTypeHintFromPath } from './file-paths.ts'

export type ListedEntry = {
  kind: 'directory' | 'file'
  path: string
}

export type StoredFileStat = {
  path: string
  size: number
  lastModified: number
}

type StoredFileBase = {
  path: string
  contentHash: string
  updatedAt: string
  size?: number
  mimeType?: string | null
}

export type StoredTextFile = StoredFileBase & {
  format: 'text'
  content: string
}

export type StoredBinaryFile = StoredFileBase & {
  format: 'binary'
  content: Uint8Array
}

export type StoredFile = StoredTextFile | StoredBinaryFile

export type RemoteBlobFile = {
  kind: 'remote-blob'
  path: string
  contentHash: string
  updatedAt: string
  size: number
  mimeType?: string | null
}

export type WriteFileInput =
  | {
      format: 'text'
      content: string
      mimeType?: string | null
    }
  | {
      format: 'binary'
      content: Uint8Array
      mimeType?: string | null
    }

export type StoredFileViewKind = 'text' | 'image' | 'attachment'

export type NoteStorage = {
  key: 'opfs' | 'directory'
  cacheKey?: string
  label: string
  listEntries(): Promise<ListedEntry[]>
  listFileStats(): Promise<StoredFileStat[]>
  listFiles(): Promise<StoredFile[]>
  readFile(path: string): Promise<StoredFile | null>
  writeFile?(path: string, file: WriteFileInput): Promise<StoredFile>
  readTextFile(path: string): Promise<StoredTextFile | null>
  writeTextFile(path: string, content: string): Promise<StoredTextFile>
  deleteEntry(path: string): Promise<void>
  createDirectory(path: string): Promise<void>
  renameEntry(path: string, nextPath: string, kind: ListedEntry['kind']): Promise<void>
}

export async function writeStoredFile(storage: NoteStorage, path: string, file: WriteFileInput): Promise<StoredFile> {
  if (storage.writeFile !== undefined) {
    return storage.writeFile(path, file)
  }

  if (file.format === 'text') {
    return storage.writeTextFile(path, file.content)
  }

  throw new Error(`Storage backend does not support binary writes for ${path}`)
}

export function isTextStoredFile(file: StoredFile | null | undefined): file is StoredTextFile {
  return file !== null && file !== undefined && file.format === 'text'
}

export function isRemoteBlobFile(file: StoredFile | RemoteBlobFile | null | undefined): file is RemoteBlobFile {
  return file !== null && file !== undefined && 'kind' in file && file.kind === 'remote-blob'
}

export function toWriteFileInput(file: StoredFile): WriteFileInput {
  return file.format === 'binary'
    ? {
        format: 'binary',
        content: file.content,
        mimeType: file.mimeType,
      }
    : {
        format: 'text',
        content: file.content,
        mimeType: file.mimeType,
      }
}

export function createStoredTextFile(options: {
  path: string
  content: string
  contentHash: string
  updatedAt: string
  size?: number
  mimeType?: string | null
}): StoredTextFile {
  return {
    path: options.path,
    format: 'text',
    content: options.content,
    contentHash: options.contentHash,
    updatedAt: options.updatedAt,
    size: options.size ?? new TextEncoder().encode(options.content).length,
    mimeType: options.mimeType ?? getMimeTypeHintFromPath(options.path),
  }
}

export function createStoredBinaryFile(options: {
  path: string
  content: Uint8Array
  contentHash: string
  updatedAt: string
  size?: number
  mimeType?: string | null
}): StoredBinaryFile {
  return {
    path: options.path,
    format: 'binary',
    content: options.content,
    contentHash: options.contentHash,
    updatedAt: options.updatedAt,
    size: options.size ?? options.content.byteLength,
    mimeType: options.mimeType ?? getMimeTypeHintFromPath(options.path),
  }
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}
