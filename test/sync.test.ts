import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import type { RemoteFile } from '../server/schemas.ts'
import { applyChanges, applyChangesToSnapshot } from '../server/sync.ts'
import { createSyncRequester, syncNow, type FlushPendingSaveResult, type SyncContext, type SyncMode } from '../web/app/sync.ts'
import { applyRemoteChanges, buildLocalChanges } from '../web/notes/sync.ts'
import { hashBytes, hashContent } from '../web/notes/hashes.ts'
import type { SyncState } from '../web/schemas.ts'
import {
  createStoredBinaryFile,
  createStoredTextFile,
  type NoteStorage,
  type StoredFile,
  type StoredTextFile,
} from '../web/storage/types.ts'

function createTextContent(value: string) {
  return {
    encoding: 'text' as const,
    value,
  }
}

vi.mock('../web/storage/metadata.ts', () => ({
  setSyncState: vi.fn(async () => {}),
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

  return {
    key: 'opfs',
    label: 'Memory',
    async listEntries() {
      return [...files.values()].map((file) => ({ kind: 'file', path: file.path }))
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

  it('rejects malformed base64 sync content before persistence', async () => {
    const originalNodeEnv = process.env.NODE_ENV

    try {
      process.env.NODE_ENV = 'development'

      const response = await createApp().fetch(
        new Request('http://localhost/api/sync/push', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Note-User': `sync-invalid-base64-${randomUUID()}`,
          },
          body: JSON.stringify({
            sinceCursor: 0,
            changes: [
              {
                kind: 'upsert',
                path: 'notes/pixel.png',
                content: {
                  encoding: 'base64',
                  value: 'not base64*',
                },
                updatedAt: '2026-04-03T11:00:00.000Z',
                base: null,
              },
            ],
          }),
        }),
      )

      expect(response.status).toBe(400)
    } finally {
      process.env.NODE_ENV = originalNodeEnv
    }
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

  it('serializes binary files as base64 sync upserts', async () => {
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
          encoding: 'base64',
          value: Buffer.from(bytes).toString('base64'),
        },
        updatedAt: '2026-04-03T11:00:00.000Z',
        base: null,
      },
    ])
  })

  it('applies remote deletes only to previously synced files', async () => {
    const localFiles = [
      await createStoredFile('notes/keep-local.md', 'local only', '2026-04-03T12:00:00.000Z'),
      await createStoredFile('notes/remove.md', 'remove me', '2026-04-03T12:00:00.000Z'),
    ]
    const storage = createMemoryStorage(localFiles)

    await applyRemoteChanges(storage, [
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

    const result = await applyRemoteChanges(storage, remoteFiles, new Set(), [syncedLocalFile])

    expect(result).toEqual({ hasSkippedLocalChanges: true })
    expect((await storage.readTextFile(path))?.content).toBe('newer local draft')
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
  })
})
