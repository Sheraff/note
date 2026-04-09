import type { FileContent, ManifestEntry, RemoteFile, SyncBaseEntry, SyncChange, SyncConflict } from '#server/schemas.ts'
import type { createApiClient } from '#web/api.ts'
import { getLocalFileIndex, setLocalFileIndex, type LocalFileIndexEntry } from '#web/storage/metadata.ts'
import { getMimeTypeHintFromPath } from '#web/storage/file-paths.ts'
import {
  createStoredTextFile,
  readStoredFile,
  writeStoredFile,
  type NoteStorage,
  type RemoteBlobFile,
  type StoredBinaryFile,
  type StoredFile,
  type StoredFileStat,
  type WriteFileInput,
} from '#web/storage/types.ts'
import { type SyncState } from '#web/schemas.ts'

export type SyncConflictDetails = {
  path: string
  theirsFile: StoredFile | RemoteBlobFile | null
}

type LocalManifestEntry = Omit<LocalFileIndexEntry, 'lastModified'>

type LocalManifestSnapshot = {
  manifest: LocalManifestEntry[]
  manifestByPath: Map<string, LocalManifestEntry>
  statsByPath: Map<string, StoredFileStat>
  indexByPath: Map<string, LocalFileIndexEntry>
  rereadFilesByPath: Map<string, StoredFile>
}

function areSameLocalManifestEntry(
  left: LocalManifestEntry | null | undefined,
  right: LocalManifestEntry | null | undefined,
): boolean {
  if (left == null || right == null) {
    return left == null && right == null
  }

  return left.path === right.path && left.contentHash === right.contentHash
}

function hasSameStatFingerprint(left: StoredFileStat | undefined, right: StoredFileStat | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }

  return left.size === right.size && left.lastModified === right.lastModified
}

function sortByPath<T extends { path: string }>(entries: Iterable<T>): T[] {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path))
}

function getStorageCacheKey(storage: NoteStorage): string {
  return storage.cacheKey ?? storage.key
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

function getTextContentSize(content: string): number {
  return new TextEncoder().encode(content).length
}

function getStoredFileSize(file: StoredFile): number {
  return file.size ?? (file.format === 'text' ? getTextContentSize(file.content) : file.content.byteLength)
}

function toLocalManifestEntry(file: StoredFile): LocalManifestEntry {
  return {
    path: file.path,
    contentHash: file.contentHash,
    updatedAt: file.updatedAt,
    size: getStoredFileSize(file),
    format: file.format,
    mimeType: file.mimeType ?? null,
  }
}

function toLocalFileIndexEntry(file: StoredFile, lastModified: number): LocalFileIndexEntry {
  return {
    ...toLocalManifestEntry(file),
    lastModified,
  }
}

function toLocalManifestEntryFromIndex(entry: LocalFileIndexEntry): LocalManifestEntry {
  return {
    path: entry.path,
    contentHash: entry.contentHash,
    updatedAt: entry.updatedAt,
    size: entry.size,
    format: entry.format,
    mimeType: entry.mimeType,
  }
}

function toRemoteContent(file: StoredFile): FileContent {
  return file.format === 'binary'
    ? {
      encoding: 'blob',
      hash: file.contentHash,
      size: getStoredFileSize(file),
    }
    : {
      encoding: 'text',
      value: file.content,
    }
}

function toTextWriteFileInput(content: FileContent): WriteFileInput {
  if (content.encoding !== 'text') {
    throw new Error('Expected inline text sync content')
  }

  return {
    format: 'text',
    content: content.value,
  }
}

function toConflictFileSource(file: RemoteFile): StoredFile | RemoteBlobFile | null {
  if (file.deletedAt !== null || file.content === null || file.contentHash === null) {
    return null
  }

  const mimeType = getMimeTypeHintFromPath(file.path)

  if (file.content.encoding === 'text') {
    return createStoredTextFile({
      path: file.path,
      content: file.content.value,
      contentHash: file.contentHash,
      updatedAt: file.updatedAt,
      size: getTextContentSize(file.content.value),
      mimeType,
    })
  }

  return {
    kind: 'remote-blob',
    path: file.path,
    contentHash: file.contentHash,
    updatedAt: file.updatedAt,
    size: file.content.size,
    mimeType,
  }
}

function toManifestEntry(file: RemoteFile): ManifestEntry {
  return {
    path: file.path,
    contentHash: file.contentHash,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt,
  }
}

async function listCurrentFileStats(storage: NoteStorage): Promise<StoredFileStat[]> {
  if (storage.listFileStats !== undefined) {
    return storage.listFileStats()
  }

  // TODO: based on usage, `storage.listFiles()` doesn't need to *return* the full array, this loads
  // everything into memory. Instead we should process files one by one and yield stats as we go.
  return (await storage.listFiles()).map((file) => ({
    path: file.path,
    size: getStoredFileSize(file),
    lastModified: Date.parse(file.updatedAt),
  }))
}

async function rereadLocalFileForManifest(
  storage: NoteStorage,
  path: string,
): Promise<{ file: StoredFile; manifest: LocalManifestEntry; stat: StoredFileStat } | null> {
  const file = await readStoredFile(storage, path)

  if (file === null) {
    return null
  }

  const lastModified = Date.parse(file.updatedAt)

  return {
    file,
    manifest: toLocalManifestEntry(file),
    stat: {
      path: file.path,
      size: getStoredFileSize(file),
      lastModified,
    },
  }
}

async function scanLocalManifest(storage: NoteStorage): Promise<LocalManifestSnapshot> {
  const [cachedEntries, stats] = await Promise.all([
    getLocalFileIndex(getStorageCacheKey(storage)),
    listCurrentFileStats(storage),
  ])
  const cachedByPath = new Map(cachedEntries.map((entry) => [entry.path, entry]))
  const manifest: LocalManifestEntry[] = []
  const manifestByPath = new Map<string, LocalManifestEntry>()
  const statsByPath = new Map<string, StoredFileStat>()
  const indexByPath = new Map<string, LocalFileIndexEntry>()
  const rereadFilesByPath = new Map<string, StoredFile>()

  for (const stat of sortByPath(stats)) {
    const cached = cachedByPath.get(stat.path)

    if (cached !== undefined && cached.size === stat.size && cached.lastModified === stat.lastModified) {
      const manifestEntry = toLocalManifestEntryFromIndex(cached)

      manifest.push(manifestEntry)
      manifestByPath.set(manifestEntry.path, manifestEntry)
      statsByPath.set(stat.path, stat)
      indexByPath.set(stat.path, cached)
      continue
    }

    const reread = await rereadLocalFileForManifest(storage, stat.path)

    if (reread === null) {
      continue
    }

    const indexEntry = toLocalFileIndexEntry(reread.file, reread.stat.lastModified)

    manifest.push(reread.manifest)
    manifestByPath.set(reread.file.path, reread.manifest)
    statsByPath.set(reread.file.path, reread.stat)
    indexByPath.set(reread.file.path, indexEntry)
    rereadFilesByPath.set(reread.file.path, reread.file)
  }

  await setLocalFileIndex(getStorageCacheKey(storage), sortByPath(indexByPath.values()))

  return {
    manifest,
    manifestByPath,
    statsByPath,
    indexByPath,
    rereadFilesByPath,
  }
}

async function collectLocalChangesFromManifest(options: {
  previousRemoteFiles: ManifestEntry[]
  localSnapshot: LocalManifestSnapshot
  now: string
  skippedPaths: ReadonlySet<string>
  storage: NoteStorage
}): Promise<{
  binaryFilesToUpload: StoredBinaryFile[]
  changes: SyncChange[]
}> {
  const previousByPath = new Map(options.previousRemoteFiles.map((file) => [file.path, file]))
  const binaryFilesToUpload: StoredBinaryFile[] = []
  const changes: SyncChange[] = []
  const upsertPaths: string[] = []

  for (const file of options.localSnapshot.manifest) {
    if (options.skippedPaths.has(file.path)) {
      continue
    }

    const previous = previousByPath.get(file.path)

    if (previous?.deletedAt === null && previous.contentHash === file.contentHash) {
      continue
    }

    upsertPaths.push(file.path)
  }

  for (const path of upsertPaths) {
    const previous = previousByPath.get(path)
    const rereadFile = options.localSnapshot.rereadFilesByPath.get(path)
    const file = rereadFile ?? (await readStoredFile(options.storage, path))

    if (file === null) {
      continue
    }

    if (file.format === 'binary') {
      binaryFilesToUpload.push(file)
    }

    changes.push({
      kind: 'upsert',
      path: file.path,
      content: toRemoteContent(file),
      updatedAt: file.updatedAt,
      base: createBaseEntry(previous),
    })
  }

  for (const previous of options.previousRemoteFiles) {
    if (previous.deletedAt !== null || options.skippedPaths.has(previous.path) || options.localSnapshot.manifestByPath.has(previous.path)) {
      continue
    }

    changes.push({
      kind: 'delete',
      path: previous.path,
      updatedAt: options.now,
      base: createBaseEntry(previous),
    })
  }

  return {
    binaryFilesToUpload,
    changes,
  }
}

async function uploadBinaryFiles(
  api: ReturnType<typeof createApiClient>,
  binaryFiles: StoredBinaryFile[],
): Promise<void> {
  const binaryFilesByHash = new Map(binaryFiles.map((file) => [file.contentHash, file]))

  await Promise.all(
    [...binaryFilesByHash.values()].map(async (file) => {
      await api.putBlob(file.contentHash, file.content)
    }),
  )
}

async function writeRemoteFile(
  api: ReturnType<typeof createApiClient>,
  storage: NoteStorage,
  remote: RemoteFile,
): Promise<StoredFile> {
  if (remote.content === null) {
    throw new Error(`Expected remote content for ${remote.path}`)
  }

  if (remote.content.encoding === 'text') {
    return writeStoredFile(storage, remote.path, toTextWriteFileInput(remote.content))
  }

  const bytes = await api.getBlob(remote.content.hash)

  return writeStoredFile(storage, remote.path, {
    format: 'binary',
    content: bytes,
    mimeType: getMimeTypeHintFromPath(remote.path),
  })
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

function toLocalManifestSnapshot(files: StoredFile[]): LocalManifestSnapshot {
  const manifest = files.map(toLocalManifestEntry)
  const manifestByPath = new Map(manifest.map((entry) => [entry.path, entry]))
  const statsByPath = new Map(
    files.map((file) => [
      file.path,
      {
        path: file.path,
        size: getStoredFileSize(file),
        lastModified: Date.parse(file.updatedAt),
      } satisfies StoredFileStat,
    ]),
  )
  const indexByPath = new Map(
    files.map((file) => [file.path, toLocalFileIndexEntry(file, Date.parse(file.updatedAt))]),
  )

  return {
    manifest,
    manifestByPath,
    statsByPath,
    indexByPath,
    rereadFilesByPath: new Map(files.map((file) => [file.path, file])),
  }
}

export async function applyRemoteChanges(
  api: ReturnType<typeof createApiClient>,
  storage: NoteStorage,
  remoteFiles: RemoteFile[],
  skippedPaths: ReadonlySet<string> = new Set(),
  syncStartLocalSnapshot?: LocalManifestSnapshot | StoredFile[],
): Promise<{ hasSkippedLocalChanges: boolean }> {
  const localSnapshot =
    syncStartLocalSnapshot === undefined
      ? await scanLocalManifest(storage)
      : Array.isArray(syncStartLocalSnapshot)
        ? toLocalManifestSnapshot(syncStartLocalSnapshot)
        : syncStartLocalSnapshot
  const currentStatsByPath = new Map((await listCurrentFileStats(storage)).map((stat) => [stat.path, stat]))
  const nextIndexByPath = new Map(localSnapshot.indexByPath)
  let hasSkippedLocalChanges = false

  for (const remote of remoteFiles) {
    if (skippedPaths.has(remote.path)) {
      continue
    }

    const syncStartLocal = localSnapshot.manifestByPath.get(remote.path)
    const syncStartStat = localSnapshot.statsByPath.get(remote.path)
    const currentStat = currentStatsByPath.get(remote.path)
    let currentLocal = hasSameStatFingerprint(currentStat, syncStartStat) ? syncStartLocal ?? null : null

    if (!hasSameStatFingerprint(currentStat, syncStartStat)) {
      const reread = await rereadLocalFileForManifest(storage, remote.path)

      if (reread === null) {
        nextIndexByPath.delete(remote.path)
      } else {
        const indexEntry = toLocalFileIndexEntry(reread.file, reread.stat.lastModified)

        nextIndexByPath.set(remote.path, indexEntry)
        currentLocal = reread.manifest
      }
    }

    if (remote.deletedAt !== null) {
      if (!areSameLocalManifestEntry(currentLocal, syncStartLocal)) {
        hasSkippedLocalChanges = true
        continue
      }

      if (currentLocal !== null) {
        await storage.deleteEntry(remote.path)
      }

      nextIndexByPath.delete(remote.path)
      continue
    }

    if (remote.content === null || remote.contentHash === null) {
      continue
    }

    if (currentLocal?.contentHash === remote.contentHash) {
      continue
    }

    if (!areSameLocalManifestEntry(currentLocal, syncStartLocal)) {
      hasSkippedLocalChanges = true
      continue
    }

    const writtenFile = await writeRemoteFile(api, storage, remote)
    nextIndexByPath.set(remote.path, toLocalFileIndexEntry(writtenFile, Date.parse(writtenFile.updatedAt)))
  }

  await setLocalFileIndex(getStorageCacheKey(storage), sortByPath(nextIndexByPath.values()))

  return { hasSkippedLocalChanges }
}

export function resolveSyncConflicts(conflicts: SyncConflict[]): SyncConflictDetails[] {
  return conflicts.map((conflict) => ({
    path: conflict.path,
    theirsFile: conflict.theirs === null ? null : toConflictFileSource(conflict.theirs),
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
  const localSnapshot = await scanLocalManifest(options.storage)
  const response = await options.api.getRemoteChanges(options.previousState.cursor)
  const snapshotResult = await applyRemoteChanges(options.api, options.storage, response.files, options.blockedPaths, localSnapshot)

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
  const localSnapshot = await scanLocalManifest(options.storage)
  const localChanges = await collectLocalChangesFromManifest({
    previousRemoteFiles: options.previousState.files,
    localSnapshot,
    now,
    skippedPaths: options.blockedPaths ?? new Set(),
    storage: options.storage,
  })

  // TODO: here `localChanges.binaryFilesToUpload` may contain a lot of files, all loaded into memory,
  // but we're just uploading them all separately, so we don't need to hold them all together.
  // Instead it should be an async iterable, so we can read>upload files (even in parallel still) without holding everything in memory at once.
  await uploadBinaryFiles(options.api, localChanges.binaryFilesToUpload)

  const response = await options.api.pushChanges({
    sinceCursor: options.previousState.cursor,
    changes: localChanges.changes,
  })
  const conflicts = resolveSyncConflicts(response.conflicts)
  const blockedPaths = new Set<string>(options.blockedPaths ?? [])

  for (const conflict of conflicts) {
    blockedPaths.add(conflict.path)
  }

  const snapshotResult = await applyRemoteChanges(
    options.api,
    options.storage,
    response.files,
    blockedPaths,
    localSnapshot,
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
