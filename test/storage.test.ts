import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, SyncState } from '../web/schemas.ts'
import type { NoteStorage } from '../web/storage/types.ts'
import { bootstrapWorkspace, reconnectFolder, type StorageContext } from '../web/app/storage.ts'

const {
  createDirectoryStorageMock,
  queryDirectoryPermissionMock,
  requestDirectoryPermissionMock,
  getAppSettingsMock,
  getDirectoryHandleMock,
  getSyncStateMock,
  createOpfsStorageMock,
} = vi.hoisted(() => ({
  createDirectoryStorageMock: vi.fn(),
  queryDirectoryPermissionMock: vi.fn(),
  requestDirectoryPermissionMock: vi.fn(),
  getAppSettingsMock: vi.fn(),
  getDirectoryHandleMock: vi.fn(),
  getSyncStateMock: vi.fn(),
  createOpfsStorageMock: vi.fn(),
}))

vi.mock('../web/storage/file-system-access.ts', () => ({
  createDirectoryStorage: createDirectoryStorageMock,
  queryDirectoryPermission: queryDirectoryPermissionMock,
  requestDirectoryPermission: requestDirectoryPermissionMock,
  pickDirectoryHandle: vi.fn(),
}))

vi.mock('../web/storage/metadata.ts', () => ({
  getAppSettings: getAppSettingsMock,
  getDirectoryHandle: getDirectoryHandleMock,
  getSyncState: getSyncStateMock,
  setDirectoryHandle: vi.fn(),
}))

vi.mock('../web/storage/opfs.ts', () => ({
  createOpfsStorage: createOpfsStorageMock,
}))

function createStorage(key: NoteStorage['key'], label: string): NoteStorage {
  return {
    key,
    label,
    async listEntries() {
      return []
    },
    async listFiles() {
      return []
    },
    async readTextFile() {
      return null
    },
    async writeTextFile() {
      throw new Error('not implemented')
    },
    async deleteEntry() {},
    async createDirectory() {},
    async renameEntry() {},
  }
}

function createContext(settings: AppSettings): StorageContext {
  return {
    settings: vi.fn(() => settings),
    setSettings: vi.fn(),
    saveSettings: vi.fn(async () => {}),
    setStorage: vi.fn(),
    setSyncState: vi.fn(),
    setReconnectableDirectoryName: vi.fn(),
    setErrorMessage: vi.fn(),
    refreshWorkspace: vi.fn(async () => {}),
    focusEditor: vi.fn(),
  }
}

describe('workspace storage bootstrap', () => {
  const syncState: SyncState = {
    files: [],
    lastSyncedAt: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    getSyncStateMock.mockResolvedValue(syncState)
  })

  it('reopens the saved folder when permission is already granted', async () => {
    const settings: AppSettings = {
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    }
    const handle = { name: 'Notes' } as FileSystemDirectoryHandle
    const directoryStorage = createStorage('directory', 'Notes')
    const context = createContext(settings)

    getAppSettingsMock.mockResolvedValue(settings)
    getDirectoryHandleMock.mockResolvedValue(handle)
    queryDirectoryPermissionMock.mockResolvedValue('granted')
    createDirectoryStorageMock.mockReturnValue(directoryStorage)

    await bootstrapWorkspace(context)

    expect(context.setSettings).toHaveBeenCalledWith(settings)
    expect(context.setSyncState).toHaveBeenCalledWith(syncState)
    expect(queryDirectoryPermissionMock).toHaveBeenCalledWith(handle)
    expect(createDirectoryStorageMock).toHaveBeenCalledWith(handle)
    expect(context.setStorage).toHaveBeenCalledWith(directoryStorage)
    expect(context.refreshWorkspace).toHaveBeenCalledWith('notes/today.md')
    expect(context.setReconnectableDirectoryName).toHaveBeenCalledWith(null)
    expect(requestDirectoryPermissionMock).not.toHaveBeenCalled()
    expect(createOpfsStorageMock).not.toHaveBeenCalled()
  })

  it('keeps the saved handle pending reconnect when startup permission is not granted', async () => {
    const settings: AppSettings = {
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    }
    const handle = { name: 'Notes' } as FileSystemDirectoryHandle
    const context = createContext(settings)

    getAppSettingsMock.mockResolvedValue(settings)
    getDirectoryHandleMock.mockResolvedValue(handle)
    queryDirectoryPermissionMock.mockResolvedValue('prompt')

    await bootstrapWorkspace(context)

    expect(queryDirectoryPermissionMock).toHaveBeenCalledWith(handle)
    expect(context.setStorage).toHaveBeenCalledWith(null)
    expect(context.setReconnectableDirectoryName).toHaveBeenLastCalledWith('Notes')
    expect(context.refreshWorkspace).not.toHaveBeenCalled()
    expect(createDirectoryStorageMock).not.toHaveBeenCalled()
    expect(requestDirectoryPermissionMock).not.toHaveBeenCalled()
    expect(createOpfsStorageMock).not.toHaveBeenCalled()
  })
})

describe('workspace reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reuses the saved folder handle on reconnect', async () => {
    const settings: AppSettings = {
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    }
    const handle = { name: 'Notes' } as FileSystemDirectoryHandle
    const directoryStorage = createStorage('directory', 'Notes')
    const context = createContext(settings)

    getDirectoryHandleMock.mockResolvedValue(handle)
    requestDirectoryPermissionMock.mockResolvedValue(true)
    createDirectoryStorageMock.mockReturnValue(directoryStorage)

    await reconnectFolder(context)

    expect(getDirectoryHandleMock).toHaveBeenCalledTimes(1)
    expect(requestDirectoryPermissionMock).toHaveBeenCalledWith(handle)
    expect(createDirectoryStorageMock).toHaveBeenCalledWith(handle)
    expect(context.setErrorMessage).toHaveBeenCalledWith(null)
    expect(context.setReconnectableDirectoryName).toHaveBeenCalledWith(null)
    expect(context.setStorage).toHaveBeenCalledWith(directoryStorage)
    expect(context.saveSettings).toHaveBeenCalledWith(settings)
    expect(context.refreshWorkspace).toHaveBeenCalledWith('notes/today.md')
    expect(context.focusEditor).toHaveBeenCalledTimes(1)
  })
})
