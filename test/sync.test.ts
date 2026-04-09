import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import type { RemoteFile, SyncChange } from '../server/schemas.ts'
import { applyChanges, applyChangesToSnapshot } from '../server/sync.ts'
import { createSyncRequester, syncNow, type FlushPendingSaveResult, type SyncContext, type SyncMode } from '../web/app/sync.ts'
import { applyRemoteChanges, buildLocalChanges, pullRemoteChanges, resolveSyncConflicts, syncWithServer } from '../web/notes/sync.ts'
import { hashBytes, hashContent } from '../web/notes/hashes.ts'
import type { SyncState } from '../web/schemas.ts'
import {
  createStoredBinaryFile,
  createStoredTextFile,
  type NoteStorage,
  type StoredFile,
  type StoredFileStat,
  type StoredTextFile,
} from '../web/storage/types.ts'

function createTextContent(value: string) {
  return {
    encoding: 'text' as const,
    value,
  }
}

async function createBlobContent(bytes: Uint8Array) {
  return {
    encoding: 'blob' as const,
    hash: await hashBytes(new Uint8Array(bytes)),
    size: bytes.byteLength,
  }
}

const {
  getLocalFileIndexMock,
  resetLocalFileIndexes,
  setLocalFileIndexMock,
  setSyncStateMock,
} = vi.hoisted(() => {
  const localFileIndexes = new Map<string, Array<Record<string, unknown>>>()

  return {
    getLocalFileIndexMock: vi.fn(async (storageCacheKey: string) => localFileIndexes.get(storageCacheKey) ?? []),
    resetLocalFileIndexes() {
      localFileIndexes.clear()
    },
    setLocalFileIndexMock: vi.fn(async (storageCacheKey: string, entries: Array<Record<string, unknown>>) => {
      localFileIndexes.set(storageCacheKey, entries)
    }),
    setSyncStateMock: vi.fn(async () => {}),
  }
})

vi.mock('../web/storage/metadata.ts', () => ({
  getLocalFileIndex: getLocalFileIndexMock,
  setLocalFileIndex: setLocalFileIndexMock,
  setSyncState: setSyncStateMock,
}))

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

async function skipPendingSave(): Promise<FlushPendingSaveResult> {
  return { status: 'skipped' }
}

function createSyncContext(options: {
  blockedSyncPaths?: string[]
  currentPath?: string | null
  flushPendingSave?: () => Promise<FlushPendingSaveResult>
  hasKnownLocalChangesSinceSync?: boolean
  storage: NoteStorage
  syncState: SyncState
}) {
  return {
    userId: () => 'test-user',
    blockedSyncPaths: () => options.blockedSyncPaths ?? [],
    storage: () => options.storage,
    syncState: () => options.syncState,
    currentPath: () => options.currentPath ?? null,
    setQueuedNoteConflicts: vi.fn(),
    setSyncState: vi.fn(),
    setIsSyncing: vi.fn(),
    hasKnownLocalChangesSinceSync: () => options.hasKnownLocalChangesSinceSync ?? false,
    setHasKnownLocalChangesSinceSync: vi.fn(),
    setErrorMessage: vi.fn(),
    setNoteConflict: vi.fn(),
    flushPendingSave: vi.fn(options.flushPendingSave ?? skipPendingSave),
    refreshWorkspace: vi.fn(async () => {}),
  } satisfies SyncContext
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetLocalFileIndexes()
  getLocalFileIndexMock.mockClear()
  setLocalFileIndexMock.mockClear()
  setSyncStateMock.mockClear()
})

function createDeferred() {
  let resolve: (() => void) | undefined

  return {
    promise: new Promise<void>((nextResolve) => {
      resolve = nextResolve
    }),
    resolve() {
      resolve?.()
    },
  }
}

async function createStoredFile(path: string, content: string, updatedAt: string): Promise<StoredTextFile> {
  return createStoredTextFile({
    path,
    content,
    contentHash: await hashContent(content),
    updatedAt,
  })
}

async function createRemoteFile(path: string, content: string, updatedAt: string): Promise<RemoteFile> {
  return {
    path,
    content: createTextContent(content),
    contentHash: await hashContent(content),
    updatedAt,
    deletedAt: null,
  }
}

function createManifestEntry(file: RemoteFile) {
  return {
    path: file.path,
    contentHash: file.contentHash,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt,
  }
}

function createMemoryStorage(initialFiles: StoredFile[]): NoteStorage {
  const files = new Map(initialFiles.map((file) => [file.path, file]))

  function toFileStat(file: StoredFile): StoredFileStat {
    return {
      path: file.path,
      size: file.size ?? (file.format === 'text' ? new TextEncoder().encode(file.content).length : file.content.byteLength),
      lastModified: Date.parse(file.updatedAt),
    }
  }

  return {
    key: 'opfs',
    cacheKey: 'memory-opfs',
    label: 'Memory',
    async listEntries() {
      return [...files.values()].map((file) => ({ kind: 'file', path: file.path }))
    },
    async listFileStats() {
      return [...files.values()].map(toFileStat)
    },
    async listFiles() {
      return [...files.values()]
    },
    async readFile(path) {
      return files.get(path) ?? null
    },
    async readTextFile(path) {
      const file = files.get(path)
      return file?.format === 'binary' ? null : (file ?? null)
    },
    async writeFile(path, file) {
      const storedFile =
        file.format === 'binary'
          ? createStoredBinaryFile({
              path,
              content: file.content,
              contentHash: await hashBytes(Uint8Array.from(file.content)),
              updatedAt: '2026-04-03T12:00:00.000Z',
            })
          : await createStoredFile(path, file.content, '2026-04-03T12:00:00.000Z')

      files.set(path, storedFile)
      return storedFile
    },
    async writeTextFile(path, content) {
      const file = await createStoredFile(path, content, '2026-04-03T12:00:00.000Z')
      files.set(path, file)
      return file
    },
    async deleteEntry(path) {
      files.delete(path)
    },
    async createDirectory() {},
    async renameEntry(path, nextPath) {
      const file = files.get(path)

      if (file === undefined) {
        return
      }

      files.delete(path)
      files.set(nextPath, {
        ...file,
        path: nextPath,
      })
    },
  }
}

function createLocalFileIndexEntry(file: StoredFile, lastModified = Date.parse(file.updatedAt)) {
  return {
    path: file.path,
    contentHash: file.contentHash,
    updatedAt: file.updatedAt,
    size: file.size ?? (file.format === 'text' ? new TextEncoder().encode(file.content).length : file.content.byteLength),
    lastModified,
    format: file.format,
    mimeType: file.mimeType ?? null,
  }
}

function createCountingStorage(initialFiles: StoredFile[], cacheKey = `counting-${randomUUID()}`) {
  const files = new Map(initialFiles.map((file) => [file.path, file]))
  const readCounts = new Map<string, number>()
  const listFileStats = vi.fn(async () =>
    [...files.values()].map((file) => ({
      path: file.path,
      size: file.size ?? (file.format === 'text' ? new TextEncoder().encode(file.content).length : file.content.byteLength),
      lastModified: Date.parse(file.updatedAt),
    })),
  )
  const listFiles = vi.fn(async () => {
    throw new Error('sync should not call listFiles when listFileStats is available')
  })

  const storage: NoteStorage = {
    key: 'opfs',
    cacheKey,
    label: 'Counting',
    async listEntries() {
      return [...files.values()].map((file) => ({ kind: 'file' as const, path: file.path }))
    },
    listFileStats,
    listFiles,
    async readFile(path) {
      readCounts.set(path, (readCounts.get(path) ?? 0) + 1)
      return files.get(path) ?? null
    },
    async readTextFile(path) {
      const file = files.get(path)
      return file?.format === 'text' ? file : null
    },
    async writeFile(path, file) {
      const storedFile =
        file.format === 'binary'
          ? createStoredBinaryFile({
              path,
              content: file.content,
              contentHash: await hashBytes(Uint8Array.from(file.content)),
              updatedAt: '2026-04-03T12:00:00.000Z',
            })
          : await createStoredFile(path, file.content, '2026-04-03T12:00:00.000Z')

      files.set(path, storedFile)
      return storedFile
    },
    async writeTextFile(path, content) {
      const file = await createStoredFile(path, content, '2026-04-03T12:00:00.000Z')
      files.set(path, file)
      return file
    },
    async deleteEntry(path) {
      files.delete(path)
    },
    async createDirectory() {},
    async renameEntry() {},
  }

  return {
    storage,
    listFileStats,
    listFiles,
    getReadCount(path: string) {
      return readCounts.get(path) ?? 0
    },
    getTotalReadCount() {
      return [...readCounts.values()].reduce((total, count) => total + count, 0)
    },
  }
}

describe('server sync conflicts', () => {
  it('keeps the remote version in place and returns a conflict to resolve', async () => {
    const remoteBefore = [await createRemoteFile('notes/today.md', 'remote version', '2026-04-03T10:00:00.000Z')]
    const next = applyChangesToSnapshot(remoteBefore, [
      {
        kind: 'upsert',
        path: 'notes/today.md',
        content: createTextContent('local version'),
        updatedAt: '2026-04-03T11:00:00.000Z',
        base: {
          path: 'notes/today.md',
          contentHash: 'stale-hash',
          updatedAt: '2026-04-03T09:00:00.000Z',
          deletedAt: null,
        },
      },
    ])

    const original = next.files.find((file) => file.path === 'notes/today.md')

    expect(original?.content).toEqual(createTextContent('remote version'))
    expect(next.files.some((file) => file.path.startsWith('notes/today.conflict-'))).toBe(false)
    expect(next.conflicts).toEqual([
      {
        path: 'notes/today.md',
        theirs: remoteBefore[0],
      },
    ])
  })

  it('does not surface a conflict when local content already matches the cloud version', async () => {
    const remoteBefore = [await createRemoteFile('notes/today.md', 'same content', '2026-04-03T10:00:00.000Z')]
    const next = applyChangesToSnapshot(remoteBefore, [
      {
        kind: 'upsert',
        path: 'notes/today.md',
        content: createTextContent('same content'),
        updatedAt: '2026-04-03T11:00:00.000Z',
        base: {
          path: 'notes/today.md',
          contentHash: 'stale-hash',
          updatedAt: '2026-04-03T09:00:00.000Z',
          deletedAt: null,
        },
      },
    ])

    expect(next.files).toEqual(remoteBefore)
    expect(next.conflicts).toEqual([])
  })

  it('returns only files changed since the provided cursor', async () => {
    const userId = `sync-delta-${randomUUID()}`
    const firstContent = 'first file'
    const secondContent = 'second file'

    const first = applyChanges(userId, [
      {
        kind: 'upsert',
        path: 'notes/first.md',
        content: createTextContent(firstContent),
        updatedAt: '2026-04-03T10:00:00.000Z',
        base: null,
      },
    ], 0)

    expect(first.files.map((file) => file.path)).toEqual(['notes/first.md'])

    const second = applyChanges(userId, [
      {
        kind: 'upsert',
        path: 'notes/second.md',
        content: createTextContent(secondContent),
        updatedAt: '2026-04-03T11:00:00.000Z',
        base: null,
      },
    ], first.cursor)

    expect(second.files.map((file) => file.path)).toEqual(['notes/second.md'])
    expect(second.cursor).toBeGreaterThan(first.cursor)

    const third = applyChanges(userId, [], second.cursor)

    expect(third.files).toEqual([])
    expect(third.cursor).toBe(second.cursor)
  })

  it('validates push request bodies before the handler runs', async () => {
    const originalNodeEnv = process.env.NODE_ENV

    try {
      process.env.NODE_ENV = 'development'

      const response = await createApp().fetch(
        new Request('http://localhost/api/sync/push', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Note-User': `sync-validate-${randomUUID()}`,
          },
          body: JSON.stringify({
            changes: [],
          }),
        }),
      )

      expect(response.status).toBe(400)
    } finally {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  it('accepts uploaded blobs and stores binary sync rows as blob refs', async () => {
    const userId = `sync-blob-${randomUUID()}`
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const blobContent = await createBlobContent(bytes)
    const app = createApp()

    const uploadResponse = await app.fetch(
      new Request(`http://localhost/api/blobs/${blobContent.hash}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Note-User': userId,
        },
        body: Buffer.from(bytes),
      }),
    )

    expect(uploadResponse.status).toBe(204)

    const pushResponse = await app.fetch(
      new Request('http://localhost/api/sync/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Note-User': userId,
        },
        body: JSON.stringify({
          sinceCursor: 0,
          changes: [
            {
              kind: 'upsert',
              path: 'notes/pixel.png',
              content: blobContent,
              updatedAt: '2026-04-03T11:00:00.000Z',
              base: null,
            },
          ],
        }),
      }),
    )

    expect(pushResponse.status).toBe(200)

    const snapshot = await app.fetch(
      new Request('http://localhost/api/sync/snapshot', {
        headers: {
          'X-Note-User': userId,
        },
      }),
    )

    expect(snapshot.status).toBe(200)
    await expect(snapshot.json()).resolves.toMatchObject({
      files: [
        {
          path: 'notes/pixel.png',
          content: blobContent,
          contentHash: blobContent.hash,
        },
      ],
    })

    const downloadResponse = await app.fetch(
      new Request(`http://localhost/api/blobs/${blobContent.hash}`, {
        headers: {
          'X-Note-User': userId,
        },
      }),
    )

    expect(downloadResponse.status).toBe(200)
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(bytes)
  })

  it('validates blob hash params before the handler runs', async () => {
    const response = await createApp().fetch(
      new Request('http://localhost/api/blobs/not-a-valid-hash', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Note-User': `sync-invalid-blob-param-${randomUUID()}`,
        },
        body: Buffer.from('not the expected bytes'),
      }),
    )

    expect(response.status).toBe(400)
  })

  it('validates blob hash params on blob downloads too', async () => {
    const response = await createApp().fetch(
      new Request('http://localhost/api/blobs/not-a-valid-hash', {
        headers: {
          'X-Note-User': `sync-invalid-blob-get-param-${randomUUID()}`,
        },
      }),
    )

    expect(response.status).toBe(400)
  })

  it('rejects blob uploads when the path hash does not match the uploaded bytes', async () => {
    const response = await createApp().fetch(
      new Request(`http://localhost/api/blobs/${'0'.repeat(64)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Note-User': `sync-invalid-blob-hash-${randomUUID()}`,
        },
        body: Buffer.from('not the expected bytes'),
      }),
    )

    expect(response.status).toBe(400)
  })

  it('does not allow one user to download another users blob by hash', async () => {
    const ownerUserId = `sync-blob-owner-${randomUUID()}`
    const otherUserId = `sync-blob-other-${randomUUID()}`
    const bytes = new Uint8Array([1, 2, 3, 4])
    const blobContent = await createBlobContent(bytes)
    const app = createApp()

    await app.fetch(
      new Request(`http://localhost/api/blobs/${blobContent.hash}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Note-User': ownerUserId,
        },
        body: Buffer.from(bytes),
      }),
    )

    await app.fetch(
      new Request('http://localhost/api/sync/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Note-User': ownerUserId,
        },
        body: JSON.stringify({
          sinceCursor: 0,
          changes: [
            {
              kind: 'upsert',
              path: 'notes/private.data',
              content: blobContent,
              updatedAt: '2026-04-03T11:00:00.000Z',
              base: null,
            },
          ],
        }),
      }),
    )

    const response = await app.fetch(
      new Request(`http://localhost/api/blobs/${blobContent.hash}`, {
        headers: {
          'X-Note-User': otherUserId,
        },
      }),
    )

    expect(response.status).toBe(404)
  })

  it('keeps prior blob access for the owning user after the remote path changes', async () => {
    const userId = `sync-blob-history-${randomUUID()}`
    const originalBytes = new Uint8Array([1, 2, 3, 4])
    const replacementBytes = new Uint8Array([5, 6, 7, 8])
    const originalBlob = await createBlobContent(originalBytes)
    const replacementBlob = await createBlobContent(replacementBytes)
    const app = createApp()

    for (const [blobContent, bytes] of [
      [originalBlob, originalBytes],
      [replacementBlob, replacementBytes],
    ] as const) {
      const response = await app.fetch(
        new Request(`http://localhost/api/blobs/${blobContent.hash}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Note-User': userId,
          },
          body: Buffer.from(bytes),
        }),
      )

      expect(response.status).toBe(204)
    }

    const originalUpdatedAt = '2026-04-03T11:00:00.000Z'
    const replacementUpdatedAt = '2026-04-03T12:00:00.000Z'

    await app.fetch(
      new Request('http://localhost/api/sync/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Note-User': userId,
        },
        body: JSON.stringify({
          sinceCursor: 0,
          changes: [
            {
              kind: 'upsert',
              path: 'notes/blob.data',
              content: originalBlob,
              updatedAt: originalUpdatedAt,
              base: null,
            },
          ],
        }),
      }),
    )

    await app.fetch(
      new Request('http://localhost/api/sync/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Note-User': userId,
        },
        body: JSON.stringify({
          sinceCursor: 0,
          changes: [
            {
              kind: 'upsert',
              path: 'notes/blob.data',
              content: replacementBlob,
              updatedAt: replacementUpdatedAt,
              base: {
                path: 'notes/blob.data',
                contentHash: originalBlob.hash,
                updatedAt: originalUpdatedAt,
                deletedAt: null,
              },
            },
          ],
        }),
      }),
    )

    const response = await app.fetch(
      new Request(`http://localhost/api/blobs/${originalBlob.hash}`, {
        headers: {
          'X-Note-User': userId,
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(originalBytes)
  })
})

describe('client sync helpers', () => {
  it('builds upsert and delete changes from local state', async () => {
    const previousRemoteFiles = [
      await createRemoteFile('notes/keep.md', 'same', '2026-04-03T10:00:00.000Z'),
      await createRemoteFile('notes/delete.md', 'remove me', '2026-04-03T10:00:00.000Z'),
    ]
    const localFiles = [
      await createStoredFile('notes/keep.md', 'same', '2026-04-03T10:00:00.000Z'),
      await createStoredFile('notes/new.md', 'new note', '2026-04-03T11:00:00.000Z'),
    ]

    const changes = buildLocalChanges(previousRemoteFiles, localFiles, '2026-04-03T12:00:00.000Z')

    expect(changes).toEqual([
      {
        kind: 'upsert',
        path: 'notes/new.md',
        content: createTextContent('new note'),
        updatedAt: '2026-04-03T11:00:00.000Z',
        base: null,
      },
      {
        kind: 'delete',
        path: 'notes/delete.md',
        updatedAt: '2026-04-03T12:00:00.000Z',
        base: {
          path: 'notes/delete.md',
          contentHash: previousRemoteFiles[1]?.contentHash ?? null,
          updatedAt: '2026-04-03T10:00:00.000Z',
          deletedAt: null,
        },
      },
    ])
  })

  it('serializes binary files as blob-ref sync upserts', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const binaryFile = createStoredBinaryFile({
      path: 'notes/pixel.png',
      content: bytes,
      contentHash: await hashBytes(bytes),
      updatedAt: '2026-04-03T11:00:00.000Z',
    })

    const changes = buildLocalChanges([], [binaryFile], '2026-04-03T12:00:00.000Z')

    expect(changes).toEqual([
      {
        kind: 'upsert',
        path: 'notes/pixel.png',
        content: {
          encoding: 'blob',
          hash: await hashBytes(bytes),
          size: bytes.byteLength,
        },
        updatedAt: '2026-04-03T11:00:00.000Z',
        base: null,
      },
    ])
  })

  it('does not reread unchanged file bodies during a no-op full sync when the local index is warm', async () => {
    const alpha = await createStoredFile('notes/alpha.md', 'alpha', '2026-04-03T10:00:00.000Z')
    const beta = await createStoredFile('notes/beta.md', 'beta', '2026-04-03T10:30:00.000Z')
    const counting = createCountingStorage([alpha, beta])
    const previousState: SyncState = {
      files: [
        createManifestEntry({
          path: alpha.path,
          content: createTextContent(alpha.content),
          contentHash: alpha.contentHash,
          updatedAt: alpha.updatedAt,
          deletedAt: null,
        }),
        createManifestEntry({
          path: beta.path,
          content: createTextContent(beta.content),
          contentHash: beta.contentHash,
          updatedAt: beta.updatedAt,
          deletedAt: null,
        }),
      ],
      cursor: 1,
      lastSyncedAt: null,
    }

    await setLocalFileIndexMock(counting.storage.cacheKey ?? counting.storage.key, [
      createLocalFileIndexEntry(alpha),
      createLocalFileIndexEntry(beta),
    ])

    const pushChanges = vi.fn(async (payload: { sinceCursor: number; changes: SyncChange[] }) => {
      expect(payload.sinceCursor).toBe(1)
      expect(payload.changes).toEqual([])

      return {
        files: [],
        conflicts: [],
        cursor: 1,
      }
    })

    await syncWithServer({
      api: {
        pushChanges,
      } as unknown as Parameters<typeof syncWithServer>[0]['api'],
      previousState,
      storage: counting.storage,
    })

    expect(pushChanges).toHaveBeenCalledTimes(1)
    expect(counting.listFileStats).toHaveBeenCalledTimes(2)
    expect(counting.listFiles).not.toHaveBeenCalled()
    expect(counting.getTotalReadCount()).toBe(0)
  })

  it('does not reread unchanged file bodies during a no-op remote pull when the local index is warm', async () => {
    const file = await createStoredFile('notes/today.md', 'same', '2026-04-03T10:00:00.000Z')
    const counting = createCountingStorage([file])
    const previousState: SyncState = {
      files: [createManifestEntry(await createRemoteFile(file.path, file.content, file.updatedAt))],
      cursor: 1,
      lastSyncedAt: null,
    }

    await setLocalFileIndexMock(counting.storage.cacheKey ?? counting.storage.key, [createLocalFileIndexEntry(file)])

    const getRemoteChanges = vi.fn(async (sinceCursor: number) => {
      expect(sinceCursor).toBe(1)

      return {
        files: [],
        conflicts: [],
        cursor: 1,
      }
    })

    await pullRemoteChanges({
      api: {
        getRemoteChanges,
      } as unknown as Parameters<typeof pullRemoteChanges>[0]['api'],
      previousState,
      storage: counting.storage,
    })

    expect(getRemoteChanges).toHaveBeenCalledTimes(1)
    expect(counting.listFileStats).toHaveBeenCalledTimes(2)
    expect(counting.listFiles).not.toHaveBeenCalled()
    expect(counting.getTotalReadCount()).toBe(0)
  })

  it('rereads only the changed local file body during a full sync', async () => {
    const unchanged = await createStoredFile('notes/alpha.md', 'alpha', '2026-04-03T10:00:00.000Z')
    const previousChanged = await createStoredFile('notes/beta.md', 'before', '2026-04-03T10:00:00.000Z')
    const currentChanged = await createStoredFile('notes/beta.md', 'after', '2026-04-03T11:00:00.000Z')
    const counting = createCountingStorage([unchanged, currentChanged])
    const previousState: SyncState = {
      files: [
        createManifestEntry(await createRemoteFile(unchanged.path, unchanged.content, unchanged.updatedAt)),
        createManifestEntry(await createRemoteFile(previousChanged.path, previousChanged.content, previousChanged.updatedAt)),
      ],
      cursor: 2,
      lastSyncedAt: null,
    }

    await setLocalFileIndexMock(counting.storage.cacheKey ?? counting.storage.key, [
      createLocalFileIndexEntry(unchanged),
      createLocalFileIndexEntry(previousChanged),
    ])

    const pushChanges = vi.fn(async (payload: { sinceCursor: number; changes: SyncChange[] }) => {
      expect(payload.sinceCursor).toBe(2)
      expect(payload.changes.map((change) => change.path)).toEqual(['notes/beta.md'])

      return {
        files: [await createRemoteFile(currentChanged.path, currentChanged.content, currentChanged.updatedAt)],
        conflicts: [],
        cursor: 3,
      }
    })

    await syncWithServer({
      api: {
        pushChanges,
      } as unknown as Parameters<typeof syncWithServer>[0]['api'],
      previousState,
      storage: counting.storage,
    })

    expect(pushChanges).toHaveBeenCalledTimes(1)
    expect(counting.listFiles).not.toHaveBeenCalled()
    expect(counting.getReadCount('notes/alpha.md')).toBe(0)
    expect(counting.getReadCount('notes/beta.md')).toBe(1)
  })

  it('applies remote deletes only to previously synced files', async () => {
    const localFiles = [
      await createStoredFile('notes/keep-local.md', 'local only', '2026-04-03T12:00:00.000Z'),
      await createStoredFile('notes/remove.md', 'remove me', '2026-04-03T12:00:00.000Z'),
    ]
    const storage = createMemoryStorage(localFiles)

    await applyRemoteChanges({
      getBlob: vi.fn(async () => new Uint8Array()),
    } as unknown as Parameters<typeof applyRemoteChanges>[0], storage, [
      {
        path: 'notes/remove.md',
        content: null,
        contentHash: null,
        updatedAt: '2026-04-03T13:00:00.000Z',
        deletedAt: '2026-04-03T13:00:00.000Z',
      },
    ])

    expect((await storage.readTextFile('notes/remove.md'))).toBeNull()
    expect((await storage.readTextFile('notes/keep-local.md'))?.content).toBe('local only')
  })

  it('skips overwriting a file when local content changed after the sync started', async () => {
    const path = 'notes/today.md'
    const syncedLocalFile = await createStoredFile(path, 'first saved draft', '2026-04-03T11:00:00.000Z')
    const newerLocalFile = await createStoredFile(path, 'newer local draft', '2026-04-03T12:00:00.000Z')
    const storage = createMemoryStorage([newerLocalFile])
    const remoteFiles = [await createRemoteFile(path, 'first saved draft', '2026-04-03T11:00:00.000Z')]

    const result = await applyRemoteChanges(
      {
        getBlob: vi.fn(async () => new Uint8Array()),
      } as unknown as Parameters<typeof applyRemoteChanges>[0],
      storage,
      remoteFiles,
      new Set(),
      [syncedLocalFile],
    )

    expect(result).toEqual({ hasSkippedLocalChanges: true })
    expect((await storage.readTextFile(path))?.content).toBe('newer local draft')
  })

  it('downloads remote binary bytes separately when applying a changed blob ref', async () => {
    const path = 'notes/pixel.png'
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const blobContent = await createBlobContent(bytes)
    const storage = createMemoryStorage([])
    const getBlob = vi.fn(async (hash: string) => {
      expect(hash).toBe(blobContent.hash)
      return bytes
    })

    await applyRemoteChanges(
      {
        getBlob,
      } as unknown as Parameters<typeof applyRemoteChanges>[0],
      storage,
      [
        {
          path,
          content: blobContent,
          contentHash: blobContent.hash,
          updatedAt: '2026-04-03T11:00:00.000Z',
          deletedAt: null,
        },
      ],
    )

    expect(getBlob).toHaveBeenCalledTimes(1)
    expect(await storage.readFile?.(path)).toMatchObject({
      format: 'binary',
      contentHash: blobContent.hash,
      size: bytes.byteLength,
    })
  })

  it('skips downloading a remote binary blob when the local hash already matches', async () => {
    const path = 'notes/pixel.png'
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const binaryFile = createStoredBinaryFile({
      path,
      content: bytes,
      contentHash: await hashBytes(bytes),
      updatedAt: '2026-04-03T11:00:00.000Z',
    })
    const storage = createMemoryStorage([binaryFile])
    const getBlob = vi.fn(async () => {
      throw new Error('blob download should be skipped')
    })

    await applyRemoteChanges(
      {
        getBlob,
      } as unknown as Parameters<typeof applyRemoteChanges>[0],
      storage,
      [
        {
          path,
          content: {
            encoding: 'blob',
            hash: binaryFile.contentHash,
            size: bytes.byteLength,
          },
          contentHash: binaryFile.contentHash,
          updatedAt: '2026-04-03T11:00:00.000Z',
          deletedAt: null,
        },
      ],
    )

    expect(getBlob).not.toHaveBeenCalled()
  })

  it('represents remote binary conflicts as lazy blob refs instead of inline bytes', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3])
    const blobContent = await createBlobContent(bytes)

    expect(resolveSyncConflicts([
      {
        path: 'notes/blob.data',
        theirs: {
          path: 'notes/blob.data',
          content: blobContent,
          contentHash: blobContent.hash,
          updatedAt: '2026-04-03T11:00:00.000Z',
          deletedAt: null,
        },
      },
    ])).toEqual([
      {
        path: 'notes/blob.data',
        theirsFile: {
          kind: 'remote-blob',
          path: 'notes/blob.data',
          contentHash: blobContent.hash,
          updatedAt: '2026-04-03T11:00:00.000Z',
          size: bytes.byteLength,
          mimeType: null,
        },
      },
    ])
  })

  it('serializes sync requests and preserves pending-save syncs', async () => {
    const firstRun = createDeferred()
    const runCalls: Array<{ mode: SyncMode; skipPendingSave: boolean }> = []
    let runCount = 0
    const runSync = vi.fn(async (options: { mode: SyncMode; skipPendingSave: boolean }) => {
      runCalls.push(options)
      runCount += 1

      if (runCount === 1) {
        await firstRun.promise
      }
    })
    const onError = vi.fn()
    const requestSync = createSyncRequester({
      onError,
      runSync,
    })

    const firstRequest = requestSync({ mode: 'precheck-if-clean', skipPendingSave: true })
    const secondRequest = requestSync({ mode: 'precheck-if-clean', skipPendingSave: true })
    requestSync({ mode: 'full' })

    expect(secondRequest).toBe(firstRequest)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(runCalls).toEqual([{ mode: 'precheck-if-clean', skipPendingSave: true }])

    firstRun.resolve()
    await firstRequest

    expect(runSync).toHaveBeenCalledTimes(2)
    expect(runCalls).toEqual([
      { mode: 'precheck-if-clean', skipPendingSave: true },
      { mode: 'full', skipPendingSave: false },
    ])
    expect(onError).not.toHaveBeenCalled()
  })

  it('updates lastSyncedAt from the manifest when nothing changed remotely', async () => {
    const remoteFile = await createRemoteFile('notes/today.md', 'same', '2026-04-03T10:00:00.000Z')
    const storage = createMemoryStorage([await createStoredFile('notes/today.md', 'same', '2026-04-03T10:00:00.000Z')])
    const syncState: SyncState = {
      files: [createManifestEntry(remoteFile)],
      cursor: 1,
      lastSyncedAt: null,
    }
    const context = createSyncContext({
      currentPath: 'notes/today.md',
      storage,
      syncState,
    })
    const fetchMock = vi.fn(async (input: string) => {
      expect(input).toBe('/api/sync/manifest?sinceCursor=1')

      return createJsonResponse({
        files: [],
        conflicts: [],
        cursor: 1,
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    await syncNow(context, { mode: 'precheck-if-clean' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(context.flushPendingSave).toHaveBeenCalledWith({ force: true })
    expect(context.refreshWorkspace).not.toHaveBeenCalled()
    expect(context.setHasKnownLocalChangesSinceSync).not.toHaveBeenCalled()
    expect(context.setSyncState).toHaveBeenCalledWith({
      files: [createManifestEntry(remoteFile)],
      cursor: 1,
      lastSyncedAt: expect.any(String),
    })
  })

  it('applies remote changes during a clean precheck pull', async () => {
    const previousRemoteFile = await createRemoteFile('notes/today.md', 'before', '2026-04-03T10:00:00.000Z')
    const nextRemoteFile = await createRemoteFile('notes/today.md', 'after', '2026-04-03T11:00:00.000Z')
    const storage = createMemoryStorage([await createStoredFile('notes/today.md', 'before', '2026-04-03T10:00:00.000Z')])
    const syncState: SyncState = {
      files: [createManifestEntry(previousRemoteFile)],
      cursor: 1,
      lastSyncedAt: null,
    }
    const context = createSyncContext({
      currentPath: 'notes/today.md',
      storage,
      syncState,
    })
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(init).toBeUndefined()
      expect(input).toBe('/api/sync/manifest?sinceCursor=1')

      return createJsonResponse({
        files: [nextRemoteFile],
        conflicts: [],
        cursor: 2,
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    await syncNow(context, { mode: 'precheck-if-clean' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(context.refreshWorkspace).toHaveBeenCalledWith('notes/today.md')
    expect(context.setHasKnownLocalChangesSinceSync).toHaveBeenCalledWith(false)
    expect((await storage.readTextFile('notes/today.md'))?.content).toBe('after')
  })

  it('skips the manifest precheck when local changes are already known', async () => {
    const remoteFile = await createRemoteFile('notes/today.md', 'same', '2026-04-03T10:00:00.000Z')
    const storage = createMemoryStorage([await createStoredFile('notes/today.md', 'same', '2026-04-03T10:00:00.000Z')])
    const syncState: SyncState = {
      files: [createManifestEntry(remoteFile)],
      cursor: 1,
      lastSyncedAt: null,
    }
    const context = createSyncContext({
      currentPath: 'notes/today.md',
      hasKnownLocalChangesSinceSync: true,
      storage,
      syncState,
    })
    const fetchMock = vi.fn(async (input: string) => {
      expect(input).toBe('/api/sync/push')

      return createJsonResponse({
        files: [remoteFile],
        conflicts: [],
        cursor: 2,
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    await syncNow(context, { mode: 'precheck-if-clean' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(context.setHasKnownLocalChangesSinceSync).toHaveBeenCalledWith(false)
  })

  it('surfaces sync conflicts without auto-creating a conflict file', async () => {
    const previousRemoteFile = await createRemoteFile('notes/today.md', 'remote version', '2026-04-03T10:00:00.000Z')
    const mineFile = await createStoredFile('notes/today.md', 'local version', '2026-04-03T11:00:00.000Z')
    const storage = createMemoryStorage([mineFile])
    const syncState: SyncState = {
      files: [createManifestEntry(previousRemoteFile)],
      cursor: 1,
      lastSyncedAt: null,
    }
    const context = createSyncContext({
      currentPath: 'notes/today.md',
      storage,
      syncState,
    })
    const fetchMock = vi.fn(async (input: string) => {
      expect(input).toBe('/api/sync/push')

      return createJsonResponse({
        files: [previousRemoteFile],
        conflicts: [
          {
            path: 'notes/today.md',
            theirs: previousRemoteFile,
          },
        ],
        cursor: 1,
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    await syncNow(context, { mode: 'full' })

    expect((await storage.readTextFile('notes/today.md'))?.content).toBe('local version')
    expect(context.refreshWorkspace).toHaveBeenCalledWith('notes/today.md')
    expect(context.setHasKnownLocalChangesSinceSync).toHaveBeenCalledWith(true)
    expect(context.setNoteConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'text',
        path: 'notes/today.md',
        preferredMode: 'popover',
        draftContent: 'local version',
        diskFile: expect.objectContaining({
          path: 'notes/today.md',
          content: 'remote version',
          contentHash: previousRemoteFile.contentHash,
          updatedAt: '2026-04-03T10:00:00.000Z',
        }),
        loadedSnapshot: mineFile,
        source: 'remote',
      }),
    )
  })

  it('keeps local changes marked dirty when an in-flight sync response is older than the current file', async () => {
    const path = 'notes/today.md'
    const previousRemoteFile = await createRemoteFile(path, 'base remote version', '2026-04-03T10:00:00.000Z')
    const firstSavedLocalFile = await createStoredFile(path, 'first saved draft', '2026-04-03T11:00:00.000Z')
    const storage = createMemoryStorage([firstSavedLocalFile])
    const syncState: SyncState = {
      files: [createManifestEntry(previousRemoteFile)],
      cursor: 1,
      lastSyncedAt: null,
    }
    const context = createSyncContext({
      currentPath: path,
      storage,
      syncState,
    })
    const fetchMock = vi.fn(async (input: string) => {
      expect(input).toBe('/api/sync/push')

      await storage.writeTextFile(path, 'newer local draft')

      return createJsonResponse({
        files: [await createRemoteFile(path, 'first saved draft', '2026-04-03T11:00:00.000Z')],
        conflicts: [],
        cursor: 2,
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    await syncNow(context, { mode: 'full', skipPendingSave: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await storage.readTextFile(path))?.content).toBe('newer local draft')
    expect(context.setHasKnownLocalChangesSinceSync).toHaveBeenCalledWith(true)
  })

  it('skips blocked conflict paths during a follow-up sync', async () => {
    const remoteFirst = await createRemoteFile('notes/first.md', 'cloud first', '2026-04-03T10:00:00.000Z')
    const remoteSecond = await createRemoteFile('notes/second.md', 'cloud second', '2026-04-03T10:00:00.000Z')
    const localFirst = await createStoredFile('notes/first.md', 'local first', '2026-04-03T11:00:00.000Z')
    const localSecond = await createStoredFile('notes/second.md', 'local second', '2026-04-03T11:00:00.000Z')
    const storage = createMemoryStorage([localFirst, localSecond])
    const syncState: SyncState = {
      files: [createManifestEntry(remoteFirst), createManifestEntry(remoteSecond)],
      cursor: 2,
      lastSyncedAt: null,
    }
    const context = createSyncContext({
      blockedSyncPaths: ['notes/second.md'],
      currentPath: 'notes/first.md',
      storage,
      syncState,
    })
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe('/api/sync/push')

      const body = JSON.parse(init?.body as string) as { changes: Array<{ path: string }> }

      expect(body.changes.map((change) => change.path)).toEqual(['notes/first.md'])

      return createJsonResponse({
        files: [
          {
            ...remoteFirst,
            content: createTextContent('local first'),
            contentHash: await hashContent('local first'),
            updatedAt: '2026-04-03T11:00:00.000Z',
          },
          remoteSecond,
        ],
        conflicts: [],
        cursor: 3,
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    await syncNow(context, { mode: 'full', skipPendingSave: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(context.setHasKnownLocalChangesSinceSync).toHaveBeenCalledWith(true)
    expect(context.setQueuedNoteConflicts).not.toHaveBeenCalledWith([])
    expect((await storage.readTextFile('notes/second.md'))?.content).toBe('local second')
  })
})
