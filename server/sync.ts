import { createHash } from 'node:crypto'
import { comparePaths } from './files.ts'
import { getCurrentSyncCursor, getNextSyncCursor, listFiles, listFilesSinceCursor, upsertFile } from './db.ts'
import { type RemoteFile, type SyncBaseEntry, type SyncChange, type SyncConflict } from './schemas.ts'

function baseMatchesRemote(remote: RemoteFile | undefined, base: SyncBaseEntry | null): boolean {
  if (remote === undefined) {
    return base === null
  }

  if (base === null) {
    return false
  }

  return (
    remote.path === base.path &&
    remote.contentHash === base.contentHash &&
    remote.updatedAt === base.updatedAt &&
    remote.deletedAt === base.deletedAt
  )
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function createRemoteFile(path: string, content: string, updatedAt: string): RemoteFile {
  return {
    path,
    content,
    contentHash: hashContent(content),
    updatedAt,
    deletedAt: null,
  }
}

function createDeletedFile(path: string, updatedAt: string): RemoteFile {
  return {
    path,
    content: null,
    contentHash: null,
    updatedAt,
    deletedAt: updatedAt,
  }
}

function createSyncConflict(path: string, remote: RemoteFile | undefined): SyncConflict {
  return {
    path,
    theirs: remote ?? null,
  }
}

export function applyChangesToSnapshot(currentFiles: RemoteFile[], changes: SyncChange[]): {
  files: RemoteFile[]
  conflicts: SyncConflict[]
} {
  const filesByPath = new Map(currentFiles.map((file) => [file.path, file]))
  const conflicts: SyncConflict[] = []

  for (const change of changes) {
    const remote = filesByPath.get(change.path)
    const hasConflict = !baseMatchesRemote(remote, change.base)

    if (change.kind === 'upsert') {
      if (hasConflict && remote?.deletedAt === null && remote.contentHash === hashContent(change.content)) {
        continue
      }

      if (hasConflict) {
        conflicts.push(createSyncConflict(change.path, remote))
        continue
      }

      filesByPath.set(change.path, createRemoteFile(change.path, change.content, change.updatedAt))
      continue
    }

    if (hasConflict) {
      continue
    }

    filesByPath.set(change.path, createDeletedFile(change.path, change.updatedAt))
  }

  return {
    files: [...filesByPath.values()].sort((left, right) => comparePaths(left.path, right.path)),
    conflicts,
  }
}

export function applyChanges(userId: string, changes: SyncChange[], sinceCursor: number): {
  files: RemoteFile[]
  conflicts: SyncConflict[]
  cursor: number
} {
  const effectiveSinceCursor = Math.min(sinceCursor, getCurrentSyncCursor())
  const before = listFiles(userId)
  const next = applyChangesToSnapshot(before, changes)
  const beforeByPath = new Map(before.map((file) => [file.path, file]))

  for (const file of next.files) {
    const previous = beforeByPath.get(file.path)

    if (
      previous?.content === file.content &&
      previous.contentHash === file.contentHash &&
      previous.updatedAt === file.updatedAt &&
      previous.deletedAt === file.deletedAt
    ) {
      continue
    }

    upsertFile(userId, file, getNextSyncCursor())
  }

  return {
    files: listFilesSinceCursor(userId, effectiveSinceCursor),
    conflicts: next.conflicts,
    cursor: getCurrentSyncCursor(),
  }
}
