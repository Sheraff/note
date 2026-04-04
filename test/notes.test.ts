import { describe, expect, it } from 'vitest'
import { createFolder, type NoteContext } from '../web/app/notes.ts'
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
  }
}

function createMockContext(storage: NoteStorage, setErrorMessage: (message: string | null) => void): NoteContext {
  const settings: AppSettings = {
    backend: 'directory',
    lastOpenedPath: null,
  }

  const entries: ListedEntry[] = []

  return {
    storage: () => storage,
    entries: () => entries,
    currentPath: () => null,
    setCurrentPath() {},
    draftContent: () => '',
    setDraftContent() {},
    settings: () => settings,
    async saveSettings() {},
    setEntries() {},
    setStatusMessage() {},
    setIsSaving() {},
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
})
