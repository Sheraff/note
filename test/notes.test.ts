import { describe, expect, it, vi } from 'vitest'
import { createFolder, moveEntry, refreshWorkspace, renameEntry, saveCurrentNote, type NoteConflict, type NoteContext } from '../web/app/notes.ts'
import { hashContent } from '../web/notes/hashes.ts'
import type { AppSettings } from '../web/schemas.ts'
import type { ListedEntry, NoteStorage, StoredFile } from '../web/storage/types.ts'

async function createStoredFile(path: string, content: string, updatedAt: string): Promise<StoredFile> {
  return {
    path,
    content,
    contentHash: await hashContent(content),
    updatedAt,
  }
}

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
    draftContent?: string
    entries?: ListedEntry[]
    loadedFileSnapshot?: StoredFile | null
    noteConflict?: NoteConflict | null
    saveSettings?: (settings: AppSettings) => Promise<void>
    setDraftContent?: (content: string) => void
    setEntries?: (entries: ListedEntry[]) => void
    setCurrentPath?: (path: string | null) => void
    setEditorValue?: (value: string) => void
    setLoadedFileSnapshot?: (file: StoredFile | null) => void
    setNoteConflict?: (conflict: NoteConflict | null) => void
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
    noteConflict: () => options.noteConflict ?? null,
    setCurrentPath: options.setCurrentPath ?? (() => {}),
    draftContent: () => options.draftContent ?? '',
    setDraftContent: options.setDraftContent ?? (() => {}),
    settings: () => settings,
    saveSettings: options.saveSettings ?? (async () => {}),
    setEntries: options.setEntries ?? (() => {}),
    setErrorMessage,
    setEditorValue: options.setEditorValue ?? (() => {}),
    loadedFileSnapshot: () => options.loadedFileSnapshot ?? null,
    setLoadedFileSnapshot: options.setLoadedFileSnapshot ?? (() => {}),
    setNoteConflict: options.setNoteConflict ?? (() => {}),
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
        noteConflict: () => null,
        setCurrentPath,
        draftContent: () => '',
        setDraftContent() {},
        settings: () => settings,
        saveSettings,
        setEntries,
        setErrorMessage() {},
        setEditorValue,
        loadedFileSnapshot: () => null,
        setLoadedFileSnapshot() {},
        setNoteConflict() {},
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
        noteConflict: () => null,
        setCurrentPath,
        draftContent: () => '',
        setDraftContent() {},
        settings: () => settings,
        async saveSettings() {},
        setEntries() {},
        setErrorMessage() {},
        setEditorValue() {},
        loadedFileSnapshot: () => null,
        setLoadedFileSnapshot() {},
        setNoteConflict() {},
      },
      { kind: 'directory', path: 'notes' },
      'archive',
    )

    expect(message).toBeNull()
    expect(renameEntryMock).toHaveBeenCalledWith('notes', 'archive', 'directory')
    expect(setCurrentPath).toHaveBeenCalledWith('archive/today.md')
  })
})

describe('moveEntry', () => {
  it('moves a file into another folder and refreshes the open file path', async () => {
    const renameEntryMock = vi.fn(async () => {})
    const setCurrentPath = vi.fn()
    const setEntries = vi.fn()
    const saveSettings = vi.fn(async () => {})
    const setEditorValue = vi.fn()

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
      { kind: 'directory', path: 'archive' },
      { kind: 'file', path: 'notes/today.md' },
    ]

    const result = await moveEntry(
      {
        storage: () => storage,
        entries: () => entries,
        currentPath: () => 'notes/today.md',
        noteConflict: () => null,
        setCurrentPath,
        draftContent: () => '',
        setDraftContent() {},
        settings: () => settings,
        saveSettings,
        setEntries,
        setErrorMessage() {},
        setEditorValue,
        loadedFileSnapshot: () => null,
        setLoadedFileSnapshot() {},
        setNoteConflict() {},
      },
      { kind: 'file', path: 'notes/today.md' },
      'archive',
    )

    expect(result).toEqual({
      didMove: true,
      message: null,
    })
    expect(renameEntryMock).toHaveBeenCalledWith('notes/today.md', 'archive/today.md', 'file')
    expect(setEntries).toHaveBeenCalledWith([
      { kind: 'directory', path: 'archive' },
      { kind: 'file', path: 'archive/today.md' },
    ])
    expect(setCurrentPath).toHaveBeenCalledWith('archive/today.md')
    expect(setEditorValue).toHaveBeenCalledWith('# Archived\n')
    expect(saveSettings).toHaveBeenCalledWith({
      backend: 'directory',
      lastOpenedPath: 'archive/today.md',
    })
  })

  it('moves a folder into another folder and refreshes the open descendant path', async () => {
    const renameEntryMock = vi.fn(async () => {})
    const setCurrentPath = vi.fn()
    const setEntries = vi.fn()
    const saveSettings = vi.fn(async () => {})
    const setEditorValue = vi.fn()

    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return [
          { kind: 'directory', path: 'archive' },
          { kind: 'directory', path: 'archive/notes' },
          { kind: 'file', path: 'archive/notes/today.md' },
        ]
      },
      async listFiles() {
        return []
      },
      async readTextFile(path) {
        if (path !== 'archive/notes/today.md') {
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
      { kind: 'directory', path: 'archive' },
      { kind: 'file', path: 'notes/today.md' },
    ]

    const result = await moveEntry(
      {
        storage: () => storage,
        entries: () => entries,
        currentPath: () => 'notes/today.md',
        noteConflict: () => null,
        setCurrentPath,
        draftContent: () => '',
        setDraftContent() {},
        settings: () => settings,
        saveSettings,
        setEntries,
        setErrorMessage() {},
        setEditorValue,
        loadedFileSnapshot: () => null,
        setLoadedFileSnapshot() {},
        setNoteConflict() {},
      },
      { kind: 'directory', path: 'notes' },
      'archive',
    )

    expect(result).toEqual({
      didMove: true,
      message: null,
    })
    expect(renameEntryMock).toHaveBeenCalledWith('notes', 'archive/notes', 'directory')
    expect(setEntries).toHaveBeenCalledWith([
      { kind: 'directory', path: 'archive' },
      { kind: 'directory', path: 'archive/notes' },
      { kind: 'file', path: 'archive/notes/today.md' },
    ])
    expect(setCurrentPath).toHaveBeenCalledWith('archive/notes/today.md')
    expect(setEditorValue).toHaveBeenCalledWith('# Archived\n')
    expect(saveSettings).toHaveBeenCalledWith({
      backend: 'directory',
      lastOpenedPath: 'archive/notes/today.md',
    })
  })

  it('returns a conflict when the destination folder already has a file with the same name', async () => {
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

    const result = await moveEntry(
      createMockContext(storage, () => {}, {
        entries: [
          { kind: 'directory', path: 'notes' },
          { kind: 'directory', path: 'archive' },
          { kind: 'file', path: 'notes/today.md' },
          { kind: 'file', path: 'archive/today.md' },
        ],
      }),
      { kind: 'file', path: 'notes/today.md' },
      'archive',
    )

    expect(result).toEqual({
      didMove: false,
      message: 'An entry named "today.md" already exists here.',
    })
    expect(storage.renameEntry).not.toHaveBeenCalled()
  })

  it('treats moving a file to its current folder as a no-op', async () => {
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

    const result = await moveEntry(createMockContext(storage, () => {}), { kind: 'file', path: 'notes/today.md' }, 'notes')

    expect(result).toEqual({
      didMove: false,
      message: null,
    })
    expect(storage.renameEntry).not.toHaveBeenCalled()
  })

  it('rejects moving a folder into itself', async () => {
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

    const result = await moveEntry(createMockContext(storage, () => {}), { kind: 'directory', path: 'projects' }, 'projects')

    expect(result).toEqual({
      didMove: false,
      message: 'A folder cannot be moved into itself or one of its subfolders.',
    })
    expect(storage.renameEntry).not.toHaveBeenCalled()
  })

  it('rejects moving a folder into a descendant folder', async () => {
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

    const result = await moveEntry(
      createMockContext(storage, () => {}),
      { kind: 'directory', path: 'projects' },
      'projects/archive',
    )

    expect(result).toEqual({
      didMove: false,
      message: 'A folder cannot be moved into itself or one of its subfolders.',
    })
    expect(storage.renameEntry).not.toHaveBeenCalled()
  })
})

describe('saveCurrentNote', () => {
  it('does not rewrite an unchanged note', async () => {
    const storedFile = await createStoredFile('notes/today.md', '# Today\n', '2026-04-05T00:00:00.000Z')
    const writeTextFile = vi.fn(async () => storedFile)
    const setNoteConflict = vi.fn()

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
        return storedFile
      },
      writeTextFile,
      async deleteEntry() {},
      async createDirectory() {},
      async renameEntry() {},
    }

    const result = await saveCurrentNote(
      createMockContext(storage, () => {}, {
        currentPath: 'notes/today.md',
        draftContent: '# Today\n',
        loadedFileSnapshot: storedFile,
        setNoteConflict,
      }),
    )

    expect(result).toEqual({ status: 'unchanged' })
    expect(writeTextFile).not.toHaveBeenCalled()
    expect(setNoteConflict).not.toHaveBeenCalled()
  })

  it('reloads the note when the file changed on disk and the draft is unchanged', async () => {
    const snapshot = await createStoredFile('notes/today.md', '# Today\n', '2026-04-05T00:00:00.000Z')
    const diskFile = await createStoredFile('notes/today.md', '# Updated\n', '2026-04-05T01:00:00.000Z')
    const setCurrentPath = vi.fn()
    const setDraftContent = vi.fn()
    const setEditorValue = vi.fn()
    const setLoadedFileSnapshot = vi.fn()
    const setNoteConflict = vi.fn()
    const saveSettings = vi.fn(async () => {})

    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return [{ kind: 'file', path: 'notes/today.md' }]
      },
      async listFiles() {
        return []
      },
      async readTextFile() {
        return diskFile
      },
      async writeTextFile() {
        return diskFile
      },
      async deleteEntry() {},
      async createDirectory() {},
      async renameEntry() {},
    }

    const result = await saveCurrentNote(
      createMockContext(storage, () => {}, {
        currentPath: 'notes/today.md',
        draftContent: '# Today\n',
        loadedFileSnapshot: snapshot,
        saveSettings,
        setCurrentPath,
        setDraftContent,
        setEditorValue,
        setLoadedFileSnapshot,
        setNoteConflict,
      }),
    )

    expect(result).toEqual({ status: 'reloaded' })
    expect(setCurrentPath).toHaveBeenCalledWith('notes/today.md')
    expect(setDraftContent).toHaveBeenCalledWith('# Updated\n')
    expect(setEditorValue).toHaveBeenCalledWith('# Updated\n')
    expect(setLoadedFileSnapshot).toHaveBeenCalledWith(diskFile)
    expect(setNoteConflict).not.toHaveBeenCalled()
    expect(saveSettings).toHaveBeenCalledWith({
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    })
  })

  it('returns a conflict when both disk and draft changed', async () => {
    const snapshot = await createStoredFile('notes/today.md', '# Today\n', '2026-04-05T00:00:00.000Z')
    const diskFile = await createStoredFile('notes/today.md', '# Updated\n', '2026-04-05T01:00:00.000Z')
    const writeTextFile = vi.fn(async () => diskFile)
    const setNoteConflict = vi.fn()

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
        return diskFile
      },
      writeTextFile,
      async deleteEntry() {},
      async createDirectory() {},
      async renameEntry() {},
    }

    const result = await saveCurrentNote(
      createMockContext(storage, () => {}, {
        currentPath: 'notes/today.md',
        draftContent: '# Local draft\n',
        loadedFileSnapshot: snapshot,
        setNoteConflict,
      }),
    )

    expect(result).toMatchObject({
      status: 'conflict',
      conflict: {
        path: 'notes/today.md',
        draftContent: '# Local draft\n',
        diskFile,
        loadedSnapshot: snapshot,
      },
    })
    expect(writeTextFile).not.toHaveBeenCalled()
    expect(setNoteConflict).toHaveBeenCalledWith({
      path: 'notes/today.md',
      preferredMode: 'popover',
      draftContent: '# Local draft\n',
      diskFile,
      loadedSnapshot: snapshot,
      source: 'local',
    })
  })
})

describe('refreshWorkspace', () => {
  it('keeps the open note loaded when sync yielded the same content', async () => {
    const file = await createStoredFile('notes/today.md', '# Today\n', '2026-04-05T00:00:00.000Z')
    const setCurrentPath = vi.fn()
    const setDraftContent = vi.fn()
    const setEntries = vi.fn()
    const setEditorValue = vi.fn()
    const setLoadedFileSnapshot = vi.fn()
    const saveSettings = vi.fn(async () => {})

    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return [{ kind: 'file', path: 'notes/today.md' }]
      },
      async listFiles() {
        return []
      },
      async readTextFile() {
        return file
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

    await refreshWorkspace(
      createMockContext(storage, () => {}, {
        currentPath: 'notes/today.md',
        draftContent: '# Today\n',
        loadedFileSnapshot: file,
        saveSettings,
        setCurrentPath,
        setDraftContent,
        setEntries,
        setEditorValue,
        setLoadedFileSnapshot,
      }),
      'notes/today.md',
      {
        openNoteSyncSnapshot: {
          path: 'notes/today.md',
          content: '# Today\n',
        },
      },
    )

    expect(setEntries).toHaveBeenCalledWith([{ kind: 'file', path: 'notes/today.md' }])
    expect(setCurrentPath).not.toHaveBeenCalled()
    expect(setDraftContent).not.toHaveBeenCalled()
    expect(setEditorValue).not.toHaveBeenCalled()
    expect(setLoadedFileSnapshot).not.toHaveBeenCalled()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('keeps the open note loaded when the user changed it after the sync snapshot', async () => {
    const syncedFile = await createStoredFile('notes/today.md', '# Remote\n', '2026-04-05T01:00:00.000Z')
    const currentFile = await createStoredFile('notes/today.md', '# Today\n', '2026-04-05T00:00:00.000Z')
    const setCurrentPath = vi.fn()
    const setDraftContent = vi.fn()
    const setEntries = vi.fn()
    const setEditorValue = vi.fn()
    const setLoadedFileSnapshot = vi.fn()
    const saveSettings = vi.fn(async () => {})

    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return [{ kind: 'file', path: 'notes/today.md' }]
      },
      async listFiles() {
        return []
      },
      async readTextFile() {
        return syncedFile
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

    await refreshWorkspace(
      createMockContext(storage, () => {}, {
        currentPath: 'notes/today.md',
        draftContent: '# Draft\n',
        loadedFileSnapshot: currentFile,
        saveSettings,
        setCurrentPath,
        setDraftContent,
        setEntries,
        setEditorValue,
        setLoadedFileSnapshot,
      }),
      'notes/today.md',
      {
        openNoteSyncSnapshot: {
          path: 'notes/today.md',
          content: '# Today\n',
        },
      },
    )

    expect(setEntries).toHaveBeenCalledWith([{ kind: 'file', path: 'notes/today.md' }])
    expect(setCurrentPath).not.toHaveBeenCalled()
    expect(setDraftContent).not.toHaveBeenCalled()
    expect(setEditorValue).not.toHaveBeenCalled()
    expect(setLoadedFileSnapshot).not.toHaveBeenCalled()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('reloads the open note when sync changed it and the user did not', async () => {
    const currentFile = await createStoredFile('notes/today.md', '# Today\n', '2026-04-05T00:00:00.000Z')
    const syncedFile = await createStoredFile('notes/today.md', '# Remote\n', '2026-04-05T01:00:00.000Z')
    const setCurrentPath = vi.fn()
    const setDraftContent = vi.fn()
    const setEntries = vi.fn()
    const setEditorValue = vi.fn()
    const setLoadedFileSnapshot = vi.fn()
    const saveSettings = vi.fn(async () => {})

    const storage: NoteStorage = {
      key: 'directory',
      label: 'Notes',
      async listEntries() {
        return [{ kind: 'file', path: 'notes/today.md' }]
      },
      async listFiles() {
        return []
      },
      async readTextFile() {
        return syncedFile
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

    await refreshWorkspace(
      createMockContext(storage, () => {}, {
        currentPath: 'notes/today.md',
        draftContent: '# Today\n',
        loadedFileSnapshot: currentFile,
        saveSettings,
        setCurrentPath,
        setDraftContent,
        setEntries,
        setEditorValue,
        setLoadedFileSnapshot,
      }),
      'notes/today.md',
      {
        openNoteSyncSnapshot: {
          path: 'notes/today.md',
          content: '# Today\n',
        },
      },
    )

    expect(setEntries).toHaveBeenCalledWith([{ kind: 'file', path: 'notes/today.md' }])
    expect(setCurrentPath).toHaveBeenCalledWith('notes/today.md')
    expect(setDraftContent).toHaveBeenCalledWith('# Remote\n')
    expect(setEditorValue).toHaveBeenCalledWith('# Remote\n')
    expect(setLoadedFileSnapshot).toHaveBeenCalledWith(syncedFile)
    expect(saveSettings).toHaveBeenCalledWith({
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    })
  })
})
