import type { RemoteFile, SyncBaseEntry, SyncChange } from '../../server/schemas.ts'
import type { createApiClient } from '../api.ts'
import { type SyncState } from '../schemas.ts'
import type { NoteStorage, StoredFile } from '../storage/types.ts'

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
): Promise<void> {
  const localFiles = await storage.listFiles()
  const localByPath = new Map(localFiles.map((file) => [file.path, file]))
  const remoteByPath = new Map(remoteFiles.map((file) => [file.path, file]))

  for (const previous of previousRemoteFiles) {
    if (previous.deletedAt !== null) {
      continue
    }

    const remote = remoteByPath.get(previous.path)

    if (remote === undefined || remote.deletedAt !== null) {
      await storage.deleteEntry(previous.path)
    }
  }

  for (const remote of remoteFiles) {
    if (remote.deletedAt !== null || remote.content === null) {
      continue
    }

    const local = localByPath.get(remote.path)

    if (local?.contentHash === remote.contentHash) {
      continue
    }

    await storage.writeTextFile(remote.path, remote.content)
  }
}

export async function syncWithServer(options: {
  api: ReturnType<typeof createApiClient>
  previousState: SyncState
  storage: NoteStorage
}): Promise<SyncState> {
  const now = new Date().toISOString()
  const localFiles = await options.storage.listFiles()
  const changes = buildLocalChanges(options.previousState.files, localFiles, now)
  const response = await options.api.pushChanges({ changes })

  await applyRemoteSnapshot(options.storage, options.previousState.files, response.files)

  return {
    files: response.files,
    lastSyncedAt: new Date().toISOString(),
  }
}
