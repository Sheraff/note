import type { FileContent, ManifestEntry, RemoteFile, SyncBaseEntry, SyncChange, SyncConflict } from '#server/schemas.ts'
import type { createApiClient } from '#web/api.ts'
import { type SyncState } from '#web/schemas.ts'
import { getMimeTypeHintFromPath } from '#web/storage/file-paths.ts'
import {
  createStoredBinaryFile,
  createStoredTextFile,
  writeStoredFile,
  type NoteStorage,
  type StoredFile,
  type WriteFileInput,
} from '#web/storage/types.ts'

export type SyncConflictDetails = {
  path: string
  theirsFile: StoredFile | null
}

function areSameStoredFile(left: StoredFile | null | undefined, right: StoredFile | null | undefined): boolean {
  if (left == null || right == null) {
    return left == null && right == null
  }

  return left.path === right.path && left.contentHash === right.contentHash
}

function createBaseEntry(file: ManifestEntry | undefined): SyncBaseEntry | null {
  if (file === undefined) {
    return null
  }

  return {
    path: file.path,
    contentHash: file.contentHash,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function getTextContentSize(content: string): number {
  return new TextEncoder().encode(content).length
}

function toRemoteContent(file: StoredFile): FileContent {
  return file.format === 'binary'
    ? {
        encoding: 'base64',
        value: bytesToBase64(file.content),
      }
    : {
        encoding: 'text',
        value: file.content,
      }
}

function toWriteFileInput(content: FileContent): WriteFileInput {
  if (content.encoding === 'text') {
    return {
      format: 'text',
      content: content.value,
    }
  }

  return {
    format: 'binary',
    content: base64ToBytes(content.value),
  }
}

function toStoredConflictFile(file: RemoteFile): StoredFile | null {
  if (file.deletedAt !== null || file.content === null || file.contentHash === null) {
    return null
  }

  const mimeType = getMimeTypeHintFromPath(file.path)

  return file.content.encoding === 'text'
    ? createStoredTextFile({
        path: file.path,
        content: file.content.value,
        contentHash: file.contentHash,
        updatedAt: file.updatedAt,
        size: getTextContentSize(file.content.value),
        mimeType,
      })
    : createStoredBinaryFile({
        path: file.path,
        content: base64ToBytes(file.content.value),
        contentHash: file.contentHash,
        updatedAt: file.updatedAt,
        mimeType,
      })
}

function toManifestEntry(file: RemoteFile): ManifestEntry {
  return {
    path: file.path,
    contentHash: file.contentHash,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt,
  }
}

export function mergeRemoteFiles(previousFiles: ManifestEntry[], remoteFiles: RemoteFile[]): ManifestEntry[] {
  const nextFilesByPath = new Map(previousFiles.map((file) => [file.path, file]))

  for (const remoteFile of remoteFiles) {
    nextFilesByPath.set(remoteFile.path, toManifestEntry(remoteFile))
  }

  return [...nextFilesByPath.values()].sort((left, right) => left.path.localeCompare(right.path))
}

export function buildLocalChanges(
  previousRemoteFiles: ManifestEntry[],
  localFiles: StoredFile[],
  now: string,
  skippedPaths: ReadonlySet<string> = new Set(),
): SyncChange[] {
  const previousByPath = new Map(previousRemoteFiles.map((file) => [file.path, file]))
  const localByPath = new Map(localFiles.map((file) => [file.path, file]))
  const changes: SyncChange[] = []

  for (const file of localFiles) {
    if (skippedPaths.has(file.path)) {
      continue
    }

    const previous = previousByPath.get(file.path)

    if (previous?.deletedAt === null && previous.contentHash === file.contentHash) {
      continue
    }

    changes.push({
      kind: 'upsert',
      path: file.path,
      content: toRemoteContent(file),
      updatedAt: file.updatedAt,
      base: createBaseEntry(previous),
    })
  }

  for (const previous of previousRemoteFiles) {
    if (previous.deletedAt !== null || skippedPaths.has(previous.path) || localByPath.has(previous.path)) {
      continue
    }

    changes.push({
      kind: 'delete',
      path: previous.path,
      updatedAt: now,
      base: createBaseEntry(previous),
    })
  }

  return changes
}

export async function applyRemoteChanges(
  storage: NoteStorage,
  remoteFiles: RemoteFile[],
  skippedPaths: ReadonlySet<string> = new Set(),
  syncStartLocalFiles?: StoredFile[],
): Promise<{ hasSkippedLocalChanges: boolean }> {
  const currentLocalFiles = await storage.listFiles()
  const currentLocalByPath = new Map(currentLocalFiles.map((file) => [file.path, file]))
  const syncStartLocalByPath = new Map((syncStartLocalFiles ?? currentLocalFiles).map((file) => [file.path, file]))
  let hasSkippedLocalChanges = false

  for (const remote of remoteFiles) {
    if (skippedPaths.has(remote.path)) {
      continue
    }

    const local = currentLocalByPath.get(remote.path)
    const syncStartLocal = syncStartLocalByPath.get(remote.path)

    if (remote.deletedAt !== null) {
      if (!areSameStoredFile(local, syncStartLocal)) {
        hasSkippedLocalChanges = true
        continue
      }

      await storage.deleteEntry(remote.path)
      continue
    }

    if (remote.content === null) {
      continue
    }

    if (local?.contentHash === remote.contentHash) {
      continue
    }

    if (!areSameStoredFile(local, syncStartLocal)) {
      hasSkippedLocalChanges = true
      continue
    }

    await writeStoredFile(storage, remote.path, toWriteFileInput(remote.content))
  }

  return { hasSkippedLocalChanges }
}

function toConflictStoredFile(file: RemoteFile | null): StoredFile | null {
  return file === null ? null : toStoredConflictFile(file)
}

export function resolveSyncConflicts(conflicts: SyncConflict[]): SyncConflictDetails[] {
  return conflicts.map((conflict) => ({
    path: conflict.path,
    theirsFile: toConflictStoredFile(conflict.theirs),
  }))
}

export async function pullRemoteChanges(options: {
  api: ReturnType<typeof createApiClient>
  blockedPaths?: ReadonlySet<string>
  previousState: SyncState
  storage: NoteStorage
}): Promise<{
  syncState: SyncState
  hasSkippedLocalChanges: boolean
  receivedRemoteChanges: boolean
}> {
  const localFiles = await options.storage.listFiles()
  const response = await options.api.getRemoteChanges(options.previousState.cursor)
  const snapshotResult = await applyRemoteChanges(options.storage, response.files, options.blockedPaths, localFiles)

  return {
    syncState: {
      files: mergeRemoteFiles(options.previousState.files, response.files),
      cursor: response.cursor,
      lastSyncedAt: new Date().toISOString(),
    },
    hasSkippedLocalChanges: snapshotResult.hasSkippedLocalChanges,
    receivedRemoteChanges: response.files.length > 0,
  }
}

export async function syncWithServer(options: {
  api: ReturnType<typeof createApiClient>
  blockedPaths?: ReadonlySet<string>
  previousState: SyncState
  storage: NoteStorage
}): Promise<{
  syncState: SyncState
  conflicts: SyncConflictDetails[]
  hasSkippedLocalChanges: boolean
}> {
  const now = new Date().toISOString()
  const localFiles = await options.storage.listFiles()
  const changes = buildLocalChanges(options.previousState.files, localFiles, now, options.blockedPaths)
  const response = await options.api.pushChanges({
    sinceCursor: options.previousState.cursor,
    changes,
  })
  const conflicts = resolveSyncConflicts(response.conflicts)
  const snapshotResult = await applyRemoteChanges(
    options.storage,
    response.files,
    new Set(conflicts.map((conflict) => conflict.path)),
    localFiles,
  )

  return {
    syncState: {
      files: mergeRemoteFiles(options.previousState.files, response.files),
      cursor: response.cursor,
      lastSyncedAt: new Date().toISOString(),
    },
    conflicts,
    hasSkippedLocalChanges: snapshotResult.hasSkippedLocalChanges,
  }
}
