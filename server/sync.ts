import { createHash } from 'node:crypto'
import { comparePaths, createConflictCopyPath } from './files.ts'
import { listFiles, upsertFile } from './db.ts'
import { type RemoteFile, type SyncBaseEntry, type SyncChange } from './schemas.ts'

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

function createUniqueConflictPath(filesByPath: Map<string, RemoteFile>, path: string, updatedAt: string): string {
  let attempt = 0
  let candidate = createConflictCopyPath(path, updatedAt, attempt)

  while (filesByPath.has(candidate)) {
    attempt += 1
    candidate = createConflictCopyPath(path, updatedAt, attempt)
  }

  return candidate
}

export function applyChangesToSnapshot(currentFiles: RemoteFile[], changes: SyncChange[]): RemoteFile[] {
  const filesByPath = new Map(currentFiles.map((file) => [file.path, file]))

  for (const change of changes) {
    const remote = filesByPath.get(change.path)
    const hasConflict = !baseMatchesRemote(remote, change.base)

    if (change.kind === 'upsert') {
      if (hasConflict && remote !== undefined && remote.deletedAt === null) {
        const conflictPath = createUniqueConflictPath(filesByPath, change.path, change.updatedAt)
        filesByPath.set(conflictPath, {
          ...remote,
          path: conflictPath,
        })
      }

      filesByPath.set(change.path, createRemoteFile(change.path, change.content, change.updatedAt))
      continue
    }

    if (hasConflict) {
      continue
    }

    filesByPath.set(change.path, createDeletedFile(change.path, change.updatedAt))
  }

  return [...filesByPath.values()].sort((left, right) => comparePaths(left.path, right.path))
}

export function applyChanges(userId: string, changes: SyncChange[]): RemoteFile[] {
  const before = listFiles(userId)
  const next = applyChangesToSnapshot(before, changes)
  const beforeByPath = new Map(before.map((file) => [file.path, file]))

  for (const file of next) {
    const previous = beforeByPath.get(file.path)

    if (
      previous?.content === file.content &&
      previous.contentHash === file.contentHash &&
      previous.updatedAt === file.updatedAt &&
      previous.deletedAt === file.deletedAt
    ) {
      continue
    }

    upsertFile(userId, file)
  }

  return next
}
