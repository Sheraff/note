import type { ManifestEntry, RemoteFile, SyncBaseEntry, SyncChange, SyncConflict } from '#server/schemas.ts'
import type { createApiClient } from '#web/api.ts'
import { type SyncState } from '#web/schemas.ts'
import type { NoteStorage, StoredFile } from '#web/storage/types.ts'

export type SyncConflictDetails = {
  path: string
  theirsFile: StoredFile | null
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
): SyncChange[] {
  const previousByPath = new Map(previousRemoteFiles.map((file) => [file.path, file]))
  const localByPath = new Map(localFiles.map((file) => [file.path, file]))
  const changes: SyncChange[] = []

  for (const file of localFiles) {
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
    if (previous.deletedAt !== null || localByPath.has(previous.path)) {
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
): Promise<void> {
  const localFiles = await storage.listFiles()
  const localByPath = new Map(localFiles.map((file) => [file.path, file]))
  const remoteByPath = new Map(remoteFiles.map((file) => [file.path, file]))

  for (const previous of previousRemoteFiles) {
    if (previous.deletedAt !== null || skippedPaths.has(previous.path)) {
      continue
    }

    const remote = remoteByPath.get(previous.path)

    if (remote === undefined || remote.deletedAt !== null) {
      await storage.deleteEntry(previous.path)
    }
  }

  for (const remote of remoteFiles) {
    if (remote.deletedAt !== null || remote.content === null || skippedPaths.has(remote.path)) {
      continue
    }

    const local = localByPath.get(remote.path)

    if (local?.contentHash === remote.contentHash) {
      continue
    }

    await storage.writeTextFile(remote.path, remote.content)
  }
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
  previousState: SyncState
  storage: NoteStorage
}): Promise<{
  syncState: SyncState
  conflicts: SyncConflictDetails[]
}> {
  const now = new Date().toISOString()
  const localFiles = await options.storage.listFiles()
  const changes = buildLocalChanges(options.previousState.files, localFiles, now)
  const response = await options.api.pushChanges({ changes })
  const conflicts = resolveSyncConflicts(response.conflicts)

  await applyRemoteSnapshot(options.storage, options.previousState.files, response.files, new Set(conflicts.map((conflict) => conflict.path)))

  return {
    syncState: {
      files: response.files,
      lastSyncedAt: new Date().toISOString(),
    },
    conflicts,
  }
}
