import { describe, expect, it, vi } from 'vitest'
import { createFolder, renameEntry, type NoteContext } from '../web/app/notes.ts'
import type { AppSettings } from '../web/schemas.ts'
import type { ListedEntry, NoteStorage, StoredFile } from '../web/storage/types.ts'

function createMockStorage(error: Error): NoteStorage {
  return {
    key: 'directory',
    label: 'Notes',
    async listEntries() {
      return []
    },
    async listFiles() {
      return []
    },
    async readTextFile() {
      return null
    },
    async writeTextFile(path: string, content: string): Promise<StoredFile> {
      return {
        path,
        content,
        contentHash: 'hash',
        updatedAt: new Date().toISOString(),
      }
    },
    async deleteEntry() {},
    async createDirectory() {
      throw error
    },
    async renameEntry() {
      throw error
    },
  }
}

function createMockContext(
  storage: NoteStorage,
  setErrorMessage: (message: string | null) => void,
  options: {
    currentPath?: string | null
    entries?: ListedEntry[]
    setEntries?: (entries: ListedEntry[]) => void
    setCurrentPath?: (path: string | null) => void
  } = {},
): NoteContext {
  const settings: AppSettings = {
    backend: 'directory',
    lastOpenedPath: null,
  }

  const entries = options.entries ?? []

  return {
    storage: () => storage,
    entries: () => entries,
    currentPath: () => options.currentPath ?? null,
    setCurrentPath: options.setCurrentPath ?? (() => {}),
    draftContent: () => '',
    setDraftContent() {},
    settings: () => settings,
    async saveSettings() {},
    setEntries: options.setEntries ?? (() => {}),
    setErrorMessage,
    setEditorValue() {},
  }
}

describe('inline create errors', () => {
  it('returns folder create failures without leaving a global error banner', async () => {
    let currentError: string | null = 'previous banner'

    const message = await createFolder(
      createMockContext(createMockStorage(new Error("Failed to execute 'getDirectoryHandle' on 'FileSystemDirectoryHandle': Name is not allowed.")), (value) => {
        currentError = value
      }),
      null,
      'notes',
    )

    expect(message).toBe('Enter a valid folder path.')
    expect(currentError).toBeNull()
  })

  it('returns note rename failures without leaving a global error banner', async () => {
    let currentError: string | null = 'previous banner'

    const message = await renameEntry(
      createMockContext(
        createMockStorage(new Error("Failed to execute 'move' on 'FileSystemHandle': Name is not allowed.")),
        (value) => {
          currentError = value
        },
      ),
      { kind: 'file', path: 'notes/today.md' },
      'done.md',
    )

    expect(message).toBe('Enter a valid note name.')
    expect(currentError).toBeNull()
  })

  it('rejects renaming to another path segment', async () => {
    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return []
      },
      async listFiles() {
        return []
      },
      async readTextFile() {
        return null
      },
      async writeTextFile(path: string, content: string): Promise<StoredFile> {
        return {
          path,
          content,
          contentHash: 'hash',
          updatedAt: new Date().toISOString(),
        }
      },
      async deleteEntry() {},
      async createDirectory() {},
      async renameEntry() {},
    }

    const message = await renameEntry(
      createMockContext(storage, () => {}),
      { kind: 'file', path: 'notes/today.md' },
      'archive/done.md',
    )

    expect(message).toBe('Enter a valid note name.')
  })

  it('returns a conflict when the target name already exists', async () => {
    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return []
      },
      async listFiles() {
        return []
      },
      async readTextFile() {
        return null
      },
      async writeTextFile(path: string, content: string): Promise<StoredFile> {
        return {
          path,
          content,
          contentHash: 'hash',
          updatedAt: new Date().toISOString(),
        }
      },
      async deleteEntry() {},
      async createDirectory() {},
      async renameEntry() {},
    }

    const message = await renameEntry(
      createMockContext(storage, () => {}, {
        entries: [
          { kind: 'file', path: 'notes/today.md' },
          { kind: 'file', path: 'notes/done.md' },
        ],
      }),
      { kind: 'file', path: 'notes/today.md' },
      'done.md',
    )

    expect(message).toBe('An entry named "done.md" already exists here.')
  })

  it('treats renaming to the same name as a no-op', async () => {
    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return []
      },
      async listFiles() {
        return []
      },
      async readTextFile() {
        return null
      },
      async writeTextFile(path: string, content: string): Promise<StoredFile> {
        return {
          path,
          content,
          contentHash: 'hash',
          updatedAt: new Date().toISOString(),
        }
      },
      async deleteEntry() {},
      async createDirectory() {},
      renameEntry: vi.fn(),
    }

    const message = await renameEntry(
      createMockContext(storage, () => {}, {
        entries: [{ kind: 'file', path: 'notes/today.md' }],
      }),
      { kind: 'file', path: 'notes/today.md' },
      'today.md',
    )

    expect(message).toBeNull()
    expect(storage.renameEntry).not.toHaveBeenCalled()
  })

  it('refreshes the renamed open file path', async () => {
    const renameEntryMock = vi.fn(async () => {})
    const setCurrentPath = vi.fn()
    const setEntries = vi.fn()
    const saveSettings = vi.fn(async () => {})
    const setEditorValue = vi.fn()

    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return [{ kind: 'file', path: 'notes/done.md' }]
      },
      async listFiles() {
        return []
      },
      async readTextFile(path) {
        if (path !== 'notes/done.md') {
          return null
        }

        return {
          path,
          content: '# Done\n',
          contentHash: 'hash',
          updatedAt: '2026-04-05T00:00:00.000Z',
        }
      },
      async writeTextFile(path: string, content: string): Promise<StoredFile> {
        return {
          path,
          content,
          contentHash: 'hash',
          updatedAt: new Date().toISOString(),
        }
      },
      async deleteEntry() {},
      async createDirectory() {},
      renameEntry: renameEntryMock,
    }

    const settings: AppSettings = {
      backend: 'directory',
      lastOpenedPath: null,
    }

    const entries: ListedEntry[] = [{ kind: 'file', path: 'notes/today.md' }]

    const message = await renameEntry(
      {
        storage: () => storage,
        entries: () => entries,
        currentPath: () => 'notes/today.md',
        setCurrentPath,
        draftContent: () => '',
        setDraftContent() {},
        settings: () => settings,
        saveSettings,
        setEntries,
        setErrorMessage() {},
        setEditorValue,
      },
      { kind: 'file', path: 'notes/today.md' },
      'done.md',
    )

    expect(message).toBeNull()
    expect(renameEntryMock).toHaveBeenCalledWith('notes/today.md', 'notes/done.md', 'file')
    expect(setEntries).toHaveBeenCalledWith([{ kind: 'file', path: 'notes/done.md' }])
    expect(setCurrentPath).toHaveBeenCalledWith('notes/done.md')
    expect(setEditorValue).toHaveBeenCalledWith('# Done\n')
    expect(saveSettings).toHaveBeenCalledWith({
      backend: 'directory',
      lastOpenedPath: 'notes/done.md',
    })
  })

  it('refreshes the open file inside a renamed folder', async () => {
    const renameEntryMock = vi.fn(async () => {})
    const setCurrentPath = vi.fn()

    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return [
          { kind: 'directory', path: 'archive' },
          { kind: 'file', path: 'archive/today.md' },
        ]
      },
      async listFiles() {
        return []
      },
      async readTextFile(path) {
        if (path !== 'archive/today.md') {
          return null
        }

        return {
          path,
          content: '# Archived\n',
          contentHash: 'hash',
          updatedAt: '2026-04-05T00:00:00.000Z',
        }
      },
      async writeTextFile(path: string, content: string): Promise<StoredFile> {
        return {
          path,
          content,
          contentHash: 'hash',
          updatedAt: new Date().toISOString(),
        }
      },
      async deleteEntry() {},
      async createDirectory() {},
      renameEntry: renameEntryMock,
    }

    const settings: AppSettings = {
      backend: 'directory',
      lastOpenedPath: null,
    }

    const entries: ListedEntry[] = [
      { kind: 'directory', path: 'notes' },
      { kind: 'file', path: 'notes/today.md' },
    ]

    const message = await renameEntry(
      {
        storage: () => storage,
        entries: () => entries,
        currentPath: () => 'notes/today.md',
        setCurrentPath,
        draftContent: () => '',
        setDraftContent() {},
        settings: () => settings,
        async saveSettings() {},
        setEntries() {},
        setErrorMessage() {},
        setEditorValue() {},
      },
      { kind: 'directory', path: 'notes' },
      'archive',
    )

    expect(message).toBeNull()
    expect(renameEntryMock).toHaveBeenCalledWith('notes', 'archive', 'directory')
    expect(setCurrentPath).toHaveBeenCalledWith('archive/today.md')
  })
})
