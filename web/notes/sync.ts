import type { ManifestEntry, RemoteFile, SyncBaseEntry, SyncChange, SyncConflict } from '#server/schemas.ts'
import type { createApiClient } from '#web/api.ts'
import { type SyncState } from '#web/schemas.ts'
import type { NoteStorage, StoredFile } from '#web/storage/types.ts'

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

function createBaseEntry(file: RemoteFile | undefined): SyncBaseEntry | null {
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

export function buildLocalChanges(
  previousRemoteFiles: RemoteFile[],
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
      content: file.content,
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

export async function applyRemoteSnapshot(
  storage: NoteStorage,
  previousRemoteFiles: RemoteFile[],
  remoteFiles: RemoteFile[],
  skippedPaths: ReadonlySet<string> = new Set(),
  syncStartLocalFiles?: StoredFile[],
): Promise<{ hasSkippedLocalChanges: boolean }> {
  const currentLocalFiles = await storage.listFiles()
  const currentLocalByPath = new Map(currentLocalFiles.map((file) => [file.path, file]))
  const syncStartLocalByPath = new Map((syncStartLocalFiles ?? currentLocalFiles).map((file) => [file.path, file]))
  const remoteByPath = new Map(remoteFiles.map((file) => [file.path, file]))
  let hasSkippedLocalChanges = false

  for (const previous of previousRemoteFiles) {
    if (previous.deletedAt !== null || skippedPaths.has(previous.path)) {
      continue
    }

    const remote = remoteByPath.get(previous.path)

    if (remote === undefined || remote.deletedAt !== null) {
      if (!areSameStoredFile(currentLocalByPath.get(previous.path), syncStartLocalByPath.get(previous.path))) {
        hasSkippedLocalChanges = true
        continue
      }

      await storage.deleteEntry(previous.path)
    }
  }

  for (const remote of remoteFiles) {
    if (remote.deletedAt !== null || remote.content === null || skippedPaths.has(remote.path)) {
      continue
    }

    const local = currentLocalByPath.get(remote.path)

    if (local?.contentHash === remote.contentHash) {
      continue
    }

    if (!areSameStoredFile(local, syncStartLocalByPath.get(remote.path))) {
      hasSkippedLocalChanges = true
      continue
    }

    await storage.writeTextFile(remote.path, remote.content)
  }

  return { hasSkippedLocalChanges }
}

function toConflictStoredFile(file: RemoteFile | null): StoredFile | null {
  if (file === null || file.deletedAt !== null || file.content === null || file.contentHash === null) {
    return null
  }

  return {
    path: file.path,
    content: file.content,
    contentHash: file.contentHash,
    updatedAt: file.updatedAt,
  }
}

export function resolveSyncConflicts(conflicts: SyncConflict[]): SyncConflictDetails[] {
  return conflicts.map((conflict) => ({
    path: conflict.path,
    theirsFile: toConflictStoredFile(conflict.theirs),
  }))
}

export function doesManifestMatchSyncState(manifestFiles: ManifestEntry[], syncFiles: RemoteFile[]): boolean {
  if (manifestFiles.length !== syncFiles.length) {
    return false
  }

  return manifestFiles.every((manifestFile, index) => {
    const syncFile = syncFiles[index]

    return (
      syncFile !== undefined &&
      manifestFile.path === syncFile.path &&
      manifestFile.contentHash === syncFile.contentHash &&
      manifestFile.updatedAt === syncFile.updatedAt &&
      manifestFile.deletedAt === syncFile.deletedAt
    )
  })
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
  const response = await options.api.pushChanges({ changes })
  const conflicts = resolveSyncConflicts(response.conflicts)
  const snapshotResult = await applyRemoteSnapshot(
    options.storage,
    options.previousState.files,
    response.files,
    new Set(conflicts.map((conflict) => conflict.path)),
    localFiles,
  )

  return {
    syncState: {
      files: response.files,
      lastSyncedAt: new Date().toISOString(),
    },
    conflicts,
    hasSkippedLocalChanges: snapshotResult.hasSkippedLocalChanges,
  }
}
