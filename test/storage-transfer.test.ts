import { describe, expect, it } from 'vitest'
import { copyStorageEntries, getStorageTransferConflicts, replaceStorageEntries } from '../web/storage/transfer.ts'
import { createStoredTextFile, type ListedEntry, type NoteStorage, type StoredTextFile } from '../web/storage/types.ts'

type MemoryEntry =
  | {
      kind: 'directory'
      path: string
    }
  | {
      kind: 'file'
      path: string
      content: string
    }

const DEFAULT_UPDATED_AT = '2026-04-07T00:00:00.000Z'

function getParentPaths(path: string): string[] {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const parents: string[] = []

  segments.pop()

  let current = ''

  for (const segment of segments) {
    current = current.length > 0 ? `${current}/${segment}` : segment
    parents.push(current)
  }

  return parents
}

function createStoredFile(path: string, content: string): StoredTextFile {
  return createStoredTextFile({
    path,
    content,
    contentHash: `hash:${path}:${content}`,
    updatedAt: DEFAULT_UPDATED_AT,
  })
}

function sortEntries(entries: ListedEntry[]): ListedEntry[] {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind))
}

function createMemoryStorage(seedEntries: MemoryEntry[] = []): NoteStorage {
  const directories = new Set<string>()
  const files = new Map<string, string>()

  function ensureDirectory(path: string): void {
    if (path.length === 0) {
      return
    }

    for (const parentPath of getParentPaths(path)) {
      directories.add(parentPath)
    }

    directories.add(path)
  }

  function ensureParents(path: string): void {
    for (const parentPath of getParentPaths(path)) {
      directories.add(parentPath)
    }
  }

  for (const entry of seedEntries) {
    if (entry.kind === 'directory') {
      ensureDirectory(entry.path)
      continue
    }

    ensureParents(entry.path)
    files.set(entry.path, entry.content)
  }

  return {
    key: 'opfs',
    label: 'Memory',
    async listEntries() {
      return sortEntries([
        ...[...directories].map((path) => ({ kind: 'directory' as const, path })),
        ...[...files.keys()].map((path) => ({ kind: 'file' as const, path })),
      ])
    },
    async listFiles() {
      return [...files.entries()].map(([path, content]) => createStoredFile(path, content))
    },
    async readTextFile(path) {
      const content = files.get(path)
      return content === undefined ? null : createStoredFile(path, content)
    },
    async writeTextFile(path, content) {
      ensureParents(path)
      files.set(path, content)
      return createStoredFile(path, content)
    },
    async deleteEntry(path) {
      files.delete(path)
      directories.delete(path)

      const descendantPrefix = `${path}/`

      for (const filePath of [...files.keys()]) {
        if (filePath.startsWith(descendantPrefix)) {
          files.delete(filePath)
        }
      }

      for (const directoryPath of [...directories]) {
        if (directoryPath.startsWith(descendantPrefix)) {
          directories.delete(directoryPath)
        }
      }
    },
    async createDirectory(path) {
      ensureDirectory(path)
    },
    async renameEntry(_path: string, _nextPath: string, _kind: ListedEntry['kind']) {
      throw new Error('not implemented')
    },
  }
}

describe('storage transfer helpers', () => {
  it('copies nested files and empty directories between storages', async () => {
    const source = createMemoryStorage([
      { kind: 'directory', path: 'notes/empty' },
      { kind: 'file', path: 'notes/today.md', content: '# Today\n' },
      { kind: 'file', path: 'notes/nested/idea.md', content: '# Idea\n' },
    ])
    const destination = createMemoryStorage()

    await copyStorageEntries(source, destination)

    expect(await destination.readTextFile('notes/today.md')).toMatchObject({ content: '# Today\n' })
    expect(await destination.readTextFile('notes/nested/idea.md')).toMatchObject({ content: '# Idea\n' })
    expect(sortEntries(await destination.listEntries())).toEqual(
      sortEntries([
        { kind: 'directory', path: 'notes' },
        { kind: 'directory', path: 'notes/empty' },
        { kind: 'directory', path: 'notes/nested' },
        { kind: 'file', path: 'notes/nested/idea.md' },
        { kind: 'file', path: 'notes/today.md' },
      ]),
    )
  })

  it('detects file collisions while allowing shared directories', async () => {
    const source = createMemoryStorage([
      { kind: 'directory', path: 'archive' },
      { kind: 'file', path: 'notes/today.md', content: '# Same\n' },
      { kind: 'file', path: 'notes/changed.md', content: '# New\n' },
      { kind: 'file', path: 'archive/2026.md', content: '# Archive\n' },
    ])
    const destination = createMemoryStorage([
      { kind: 'directory', path: 'notes' },
      { kind: 'file', path: 'notes/today.md', content: '# Same\n' },
      { kind: 'file', path: 'notes/changed.md', content: '# Existing\n' },
      { kind: 'file', path: 'archive', content: '# Not a folder\n' },
    ])

    expect(await getStorageTransferConflicts(source, destination, await source.listEntries(), await destination.listEntries())).toEqual([
      {
        path: 'archive',
        sourceKind: 'directory',
        destinationKind: 'file',
      },
      {
        path: 'notes/changed.md',
        sourceKind: 'file',
        destinationKind: 'file',
      },
    ])
  })

  it('ignores file collisions when contents match', async () => {
    const source = createMemoryStorage([{ kind: 'file', path: 'notes/today.md', content: '# Same\n' }])
    const destination = createMemoryStorage([{ kind: 'file', path: 'notes/today.md', content: '# Same\n' }])

    expect(await getStorageTransferConflicts(source, destination)).toEqual([])
  })

  it('replaces destination contents so it mirrors the source storage', async () => {
    const source = createMemoryStorage([
      { kind: 'directory', path: 'notes' },
      { kind: 'file', path: 'notes/current.md', content: '# Current\n' },
    ])
    const destination = createMemoryStorage([
      { kind: 'directory', path: 'notes' },
      { kind: 'file', path: 'notes/stale.md', content: '# Stale\n' },
      { kind: 'directory', path: 'archive' },
      { kind: 'file', path: 'archive/old.md', content: '# Old\n' },
    ])

    await replaceStorageEntries(source, destination)

    expect(sortEntries(await destination.listEntries())).toEqual(
      sortEntries([
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/current.md' },
      ]),
    )
    expect(await destination.readTextFile('notes/current.md')).toMatchObject({ content: '# Current\n' })
    expect(await destination.readTextFile('notes/stale.md')).toBeNull()
    expect(await destination.readTextFile('archive/old.md')).toBeNull()
  })
})
