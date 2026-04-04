import { describe, expect, it } from 'vitest'
import type { RemoteFile } from '../server/schemas.ts'
import { applyChangesToSnapshot } from '../server/sync.ts'
import { hashContent } from '../web/notes/hashes.ts'
import { applyRemoteSnapshot, buildLocalChanges } from '../web/notes/sync.ts'
import type { NoteStorage, StoredFile } from '../web/storage/types.ts'

async function createStoredFile(path: string, content: string, updatedAt: string): Promise<StoredFile> {
  return {
    path,
    content,
    contentHash: await hashContent(content),
    updatedAt,
  }
}

async function createRemoteFile(path: string, content: string, updatedAt: string): Promise<RemoteFile> {
  return {
    path,
    content,
    contentHash: await hashContent(content),
    updatedAt,
    deletedAt: null,
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
    async readTextFile(path) {
      return files.get(path) ?? null
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
  }
}

describe('server sync conflicts', () => {
  it('keeps the local version at the original path and copies the remote version', async () => {
    const remoteBefore = [await createRemoteFile('notes/today.md', 'remote version', '2026-04-03T10:00:00.000Z')]
    const next = applyChangesToSnapshot(remoteBefore, [
      {
        kind: 'upsert',
        path: 'notes/today.md',
        content: 'local version',
        updatedAt: '2026-04-03T11:00:00.000Z',
        base: {
          path: 'notes/today.md',
          contentHash: 'stale-hash',
          updatedAt: '2026-04-03T09:00:00.000Z',
          deletedAt: null,
        },
      },
    ])

    const original = next.find((file) => file.path === 'notes/today.md')
    const conflict = next.find((file) => file.path.startsWith('notes/today.conflict-'))

    expect(original?.content).toBe('local version')
    expect(conflict?.content).toBe('remote version')
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
        content: 'new note',
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

  it('applies remote deletes only to previously synced files', async () => {
    const localFiles = [
      await createStoredFile('notes/keep-local.md', 'local only', '2026-04-03T12:00:00.000Z'),
      await createStoredFile('notes/remove.md', 'remove me', '2026-04-03T12:00:00.000Z'),
    ]
    const storage = createMemoryStorage(localFiles)
    const previousRemoteFiles = [await createRemoteFile('notes/remove.md', 'remove me', '2026-04-03T10:00:00.000Z')]

    await applyRemoteSnapshot(storage, previousRemoteFiles, [
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
})
