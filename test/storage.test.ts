import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, type AppSettings, type SyncState } from '../web/schemas.ts'
import type { NoteStorage } from '../web/storage/types.ts'
import { attachFolder, bootstrapWorkspace, reconnectFolder, type StorageContext } from '../web/app/storage.ts'

const TEST_USER_ID = 'test-user'

function createSettings(overrides: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    ...overrides,
    openDirectoryPaths: {
      ...DEFAULT_APP_SETTINGS.openDirectoryPaths,
      ...overrides.openDirectoryPaths,
    },
  }
}

const {
  createDirectoryStorageMock,
  pickDirectoryHandleMock,
  queryDirectoryPermissionMock,
  requestDirectoryPermissionMock,
  getAppSettingsMock,
  getDirectoryHandleMock,
  getSyncStateMock,
  setDirectoryHandleMock,
  createOpfsStorageMock,
} = vi.hoisted(() => ({
  createDirectoryStorageMock: vi.fn(),
  pickDirectoryHandleMock: vi.fn(),
  queryDirectoryPermissionMock: vi.fn(),
  requestDirectoryPermissionMock: vi.fn(),
  getAppSettingsMock: vi.fn(),
  getDirectoryHandleMock: vi.fn(),
  getSyncStateMock: vi.fn(),
  setDirectoryHandleMock: vi.fn(),
  createOpfsStorageMock: vi.fn(),
}))

vi.mock('../web/storage/file-system-access.ts', () => ({
  createDirectoryStorage: createDirectoryStorageMock,
  pickDirectoryHandle: pickDirectoryHandleMock,
  queryDirectoryPermission: queryDirectoryPermissionMock,
  requestDirectoryPermission: requestDirectoryPermissionMock,
}))

vi.mock('../web/storage/metadata.ts', () => ({
  getAppSettings: getAppSettingsMock,
  getDirectoryHandle: getDirectoryHandleMock,
  getSyncState: getSyncStateMock,
  setDirectoryHandle: setDirectoryHandleMock,
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
    userId: vi.fn(() => TEST_USER_ID),
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

function createNotFoundError(message: string): DOMException {
  return new DOMException(message, 'NotFoundError')
}

function createTypeMismatchError(message: string): DOMException {
  return new DOMException(message, 'TypeMismatchError')
}

class MemoryFileHandle {
  readonly kind = 'file'
  readonly name: string
  content = ''
  lastModified = Date.now()

  constructor(name: string) {
    this.name = name
  }

  async createWritable() {
    let nextContent = this.content

    return {
      write: async (value: string) => {
        nextContent = value
      },
      close: async () => {
        this.content = nextContent
        this.lastModified = Date.now()
      },
    }
  }

  async getFile(): Promise<File> {
    return {
      lastModified: this.lastModified,
      name: this.name,
      text: async () => this.content,
    } as unknown as File
  }
}

class MemoryDirectoryHandle {
  readonly kind = 'directory'
  readonly name: string
  readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>()

  constructor(name: string) {
    this.name = name
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryDirectoryHandle> {
    const existing = this.children.get(name)

    if (existing instanceof MemoryDirectoryHandle) {
      return existing
    }

    if (existing instanceof MemoryFileHandle) {
      throw createTypeMismatchError(`Expected ${name} to be a directory`)
    }

    if (options.create === true) {
      const directory = new MemoryDirectoryHandle(name)
      this.children.set(name, directory)
      return directory
    }

    throw createNotFoundError(`Missing directory ${name}`)
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryFileHandle> {
    const existing = this.children.get(name)

    if (existing instanceof MemoryFileHandle) {
      return existing
    }

    if (existing instanceof MemoryDirectoryHandle) {
      throw createTypeMismatchError(`Expected ${name} to be a file`)
    }

    if (options.create === true) {
      const file = new MemoryFileHandle(name)
      this.children.set(name, file)
      return file
    }

    throw createNotFoundError(`Missing file ${name}`)
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    const existing = this.children.get(name)

    if (existing === undefined) {
      throw createNotFoundError(`Missing entry ${name}`)
    }

    if (existing instanceof MemoryDirectoryHandle && existing.children.size > 0 && options.recursive !== true) {
      throw new DOMException(`Directory ${name} is not empty`, 'InvalidModificationError')
    }

    this.children.delete(name)
  }

  async *entries(): AsyncIterableIterator<[string, MemoryDirectoryHandle | MemoryFileHandle]> {
    for (const entry of this.children.entries()) {
      yield entry
    }
  }
}

async function writeFileToRoot(root: MemoryDirectoryHandle, path: string, content: string): Promise<void> {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const fileName = segments.pop()

  if (fileName === undefined) {
    throw new Error(`Expected a file path, got ${path}`)
  }

  let directory = root

  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create: true })
  }

  const fileHandle = await directory.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
}

async function readFileFromRoot(root: MemoryDirectoryHandle, path: string): Promise<string | null> {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const fileName = segments.pop()

  if (fileName === undefined) {
    return null
  }

  let directory = root

  for (const segment of segments) {
    const next = directory.children.get(segment)

    if (!(next instanceof MemoryDirectoryHandle)) {
      return null
    }

    directory = next
  }

  const file = directory.children.get(fileName)

  return file instanceof MemoryFileHandle ? file.content : null
}

async function listRootEntries(root: MemoryDirectoryHandle, prefix = ''): Promise<Array<{ kind: 'directory' | 'file'; path: string }>> {
  const entries: Array<{ kind: 'directory' | 'file'; path: string }> = []

  for await (const [name, handle] of root.entries()) {
    const path = prefix.length > 0 ? `${prefix}/${name}` : name

    entries.push({ kind: handle.kind, path })

    if (handle instanceof MemoryDirectoryHandle) {
      entries.push(...(await listRootEntries(handle, path)))
    }
  }

  return entries
}

function sortEntries(entries: Array<{ kind: 'directory' | 'file'; path: string }>) {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind))
}

function sortFiles(files: Array<{ path: string; content: string }>) {
  return [...files].sort((left, right) => left.path.localeCompare(right.path))
}

type StorageHarness = {
  root: MemoryDirectoryHandle
  storage: NoteStorage
}

async function createDirectoryStorageHarness(): Promise<StorageHarness> {
  const root = new MemoryDirectoryHandle('Notes')
  const { createDirectoryStorage } = await vi.importActual<typeof import('../web/storage/file-system-access.ts')>(
    '../web/storage/file-system-access.ts',
  )

  return {
    root,
    storage: createDirectoryStorage(root as unknown as FileSystemDirectoryHandle),
  }
}

async function createOpfsStorageHarness(): Promise<StorageHarness> {
  const root = new MemoryDirectoryHandle('OPFS')

  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: vi.fn(async () => root as unknown as FileSystemDirectoryHandle),
    },
  })

  const { createOpfsStorage } = await vi.importActual<typeof import('../web/storage/opfs.ts')>('../web/storage/opfs.ts')

  return {
    root,
    storage: createOpfsStorage(),
  }
}

function describeStorageContract(name: string, setup: () => Promise<StorageHarness>) {
  describe(name, () => {
    it('lists entries and files across nested directories', async () => {
      const { root, storage } = await setup()

      await writeFileToRoot(root, 'notes/today.md', '# Today\n')
      await writeFileToRoot(root, 'notes/daily/archive.md', '# Archive\n')
      await root.getDirectoryHandle('empty', { create: true })

      expect(sortEntries(await storage.listEntries())).toEqual(
        sortEntries([
          { kind: 'directory', path: 'empty' },
          { kind: 'directory', path: 'notes' },
          { kind: 'directory', path: 'notes/daily' },
          { kind: 'file', path: 'notes/daily/archive.md' },
          { kind: 'file', path: 'notes/today.md' },
        ]),
      )
      expect(
        sortFiles(
          (await storage.listFiles()).map((file) => ({
            path: file.path,
            content: file.content,
          })),
        ),
      ).toEqual(
        sortFiles([
          { path: 'notes/daily/archive.md', content: '# Archive\n' },
          { path: 'notes/today.md', content: '# Today\n' },
        ]),
      )
    })

    it('omits .DS_Store files from listings', async () => {
      const { root, storage } = await setup()

      await writeFileToRoot(root, '.DS_Store', 'root metadata')
      await writeFileToRoot(root, 'notes/.DS_Store', 'notes metadata')
      await writeFileToRoot(root, 'notes/daily/.DS_Store', 'daily metadata')
      await writeFileToRoot(root, 'notes/today.md', '# Today\n')
      await root.getDirectoryHandle('empty', { create: true })

      expect(sortEntries(await storage.listEntries())).toEqual(
        sortEntries([
          { kind: 'directory', path: 'empty' },
          { kind: 'directory', path: 'notes' },
          { kind: 'directory', path: 'notes/daily' },
          { kind: 'file', path: 'notes/today.md' },
        ]),
      )
      expect(
        sortFiles(
          (await storage.listFiles()).map((file) => ({
            path: file.path,
            content: file.content,
          })),
        ),
      ).toEqual(sortFiles([{ path: 'notes/today.md', content: '# Today\n' }]))
    })

    it('reads and writes normalized nested file paths', async () => {
      const { root, storage } = await setup()

      const saved = await storage.writeTextFile(' notes\\ideas//today.md ', '# Today\n')

      expect(saved.path).toBe('notes/ideas/today.md')
      expect(saved.content).toBe('# Today\n')
      expect(await readFileFromRoot(root, 'notes/ideas/today.md')).toBe('# Today\n')
      expect((await storage.readTextFile('notes\\ideas/today.md'))?.path).toBe('notes/ideas/today.md')
      expect((await storage.readTextFile('notes/ideas/today.md'))?.content).toBe('# Today\n')
      expect(await storage.readTextFile('notes/missing.md')).toBeNull()
    })

    it('creates nested directories with normalized paths', async () => {
      const { root, storage } = await setup()

      await storage.createDirectory(' notes\\projects//alpha ')

      expect(sortEntries(await listRootEntries(root))).toEqual(
        sortEntries([
          { kind: 'directory', path: 'notes' },
          { kind: 'directory', path: 'notes/projects' },
          { kind: 'directory', path: 'notes/projects/alpha' },
        ]),
      )
    })

    it('deletes files and directories without disturbing siblings and ignores missing paths', async () => {
      const { root, storage } = await setup()

      await writeFileToRoot(root, 'notes/remove.md', '# Remove\n')
      await writeFileToRoot(root, 'notes/folder/nested.md', '# Nested\n')
      await writeFileToRoot(root, 'notes/keep.md', '# Keep\n')

      await storage.deleteEntry('notes/remove.md')
      await storage.deleteEntry('notes/folder')
      await storage.deleteEntry('notes/missing.md')

      expect(await readFileFromRoot(root, 'notes/remove.md')).toBeNull()
      expect(await readFileFromRoot(root, 'notes/folder/nested.md')).toBeNull()
      expect(await readFileFromRoot(root, 'notes/keep.md')).toBe('# Keep\n')
      expect(sortEntries(await listRootEntries(root))).toEqual(
        sortEntries([
          { kind: 'directory', path: 'notes' },
          { kind: 'file', path: 'notes/keep.md' },
        ]),
      )
    })

    it('renames a file and removes the original path', async () => {
      const { root, storage } = await setup()

      await writeFileToRoot(root, 'notes/before.md', '# Before\n')
      await writeFileToRoot(root, 'notes/keep.md', '# Keep\n')

      await storage.renameEntry('notes/before.md', 'notes/after.md', 'file')

      expect(await readFileFromRoot(root, 'notes/before.md')).toBeNull()
      expect(await readFileFromRoot(root, 'notes/after.md')).toBe('# Before\n')
      expect(await readFileFromRoot(root, 'notes/keep.md')).toBe('# Keep\n')
    })

    it('overwrites an existing file when renaming a file onto it', async () => {
      const { root, storage } = await setup()

      await writeFileToRoot(root, 'notes/source.md', '# Source\n')
      await writeFileToRoot(root, 'notes/target.md', '# Target\n')

      await storage.renameEntry('notes/source.md', 'notes/target.md', 'file')

      expect(await readFileFromRoot(root, 'notes/source.md')).toBeNull()
      expect(await readFileFromRoot(root, 'notes/target.md')).toBe('# Source\n')
    })

    it('throws without changing either entry when renaming a file onto a directory', async () => {
      const { root, storage } = await setup()

      await writeFileToRoot(root, 'notes/source.md', '# Source\n')
      await root.getDirectoryHandle('notes', { create: true })
      await root.getDirectoryHandle('folder', { create: true })

      await expect(storage.renameEntry('notes/source.md', 'folder', 'file')).rejects.toThrow('Unable to open folder')

      expect(await readFileFromRoot(root, 'notes/source.md')).toBe('# Source\n')
      expect(sortEntries(await listRootEntries(root))).toEqual(
        sortEntries([
          { kind: 'directory', path: 'folder' },
          { kind: 'directory', path: 'notes' },
          { kind: 'file', path: 'notes/source.md' },
        ]),
      )
    })

    it('renames a directory and keeps descendant files intact', async () => {
      const { root, storage } = await setup()

      await writeFileToRoot(root, 'projects/alpha/one.md', '# One\n')
      await writeFileToRoot(root, 'projects/alpha/nested/two.md', '# Two\n')
      await writeFileToRoot(root, 'projects/keep.md', '# Keep\n')

      await storage.renameEntry('projects/alpha', 'archive/alpha-renamed', 'directory')

      expect(await readFileFromRoot(root, 'projects/alpha/one.md')).toBeNull()
      expect(await readFileFromRoot(root, 'projects/alpha/nested/two.md')).toBeNull()
      expect(await readFileFromRoot(root, 'archive/alpha-renamed/one.md')).toBe('# One\n')
      expect(await readFileFromRoot(root, 'archive/alpha-renamed/nested/two.md')).toBe('# Two\n')
      expect(await readFileFromRoot(root, 'projects/keep.md')).toBe('# Keep\n')
    })

    it('merges into an existing directory target and overwrites conflicting descendants', async () => {
      const { root, storage } = await setup()

      await writeFileToRoot(root, 'projects/source/conflict.md', '# From source\n')
      await writeFileToRoot(root, 'projects/source/only-source.md', '# Source only\n')
      await writeFileToRoot(root, 'archive/existing/conflict.md', '# Existing target\n')
      await writeFileToRoot(root, 'archive/existing/keep.md', '# Keep target\n')

      await storage.renameEntry('projects/source', 'archive/existing', 'directory')

      expect(await readFileFromRoot(root, 'projects/source/conflict.md')).toBeNull()
      expect(await readFileFromRoot(root, 'archive/existing/conflict.md')).toBe('# From source\n')
      expect(await readFileFromRoot(root, 'archive/existing/only-source.md')).toBe('# Source only\n')
      expect(await readFileFromRoot(root, 'archive/existing/keep.md')).toBe('# Keep target\n')
    })

    it('throws without changing either entry when renaming a directory onto a file', async () => {
      const { root, storage } = await setup()

      await writeFileToRoot(root, 'projects/source/one.md', '# One\n')
      await writeFileToRoot(root, 'archive-target.md', '# Target file\n')

      await expect(storage.renameEntry('projects/source', 'archive-target.md', 'directory')).rejects.toThrow(
        'Unable to create archive-target.md',
      )

      expect(await readFileFromRoot(root, 'projects/source/one.md')).toBe('# One\n')
      expect(await readFileFromRoot(root, 'archive-target.md')).toBe('# Target file\n')
    })

    it('throws when renaming a missing directory', async () => {
      const { storage } = await setup()

      await expect(storage.renameEntry('missing', 'archive/missing', 'directory')).rejects.toThrow('Unable to open missing')
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describeStorageContract('directory storage backend', createDirectoryStorageHarness)
describeStorageContract('opfs storage backend', createOpfsStorageHarness)

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
    const settings = createSettings({
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    })
    const handle = { name: 'Notes' } as FileSystemDirectoryHandle
    const directoryStorage = createStorage('directory', 'Notes')
    const context = createContext(settings)

    getAppSettingsMock.mockResolvedValue(settings)
    getDirectoryHandleMock.mockResolvedValue(handle)
    queryDirectoryPermissionMock.mockResolvedValue('granted')
    createDirectoryStorageMock.mockReturnValue(directoryStorage)

    await bootstrapWorkspace(context)

    expect(getAppSettingsMock).toHaveBeenCalledWith(TEST_USER_ID)
    expect(getSyncStateMock).toHaveBeenCalledWith(TEST_USER_ID)
    expect(getDirectoryHandleMock).toHaveBeenCalledWith(TEST_USER_ID)
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
    const settings = createSettings({
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    })
    const handle = { name: 'Notes' } as FileSystemDirectoryHandle
    const context = createContext(settings)

    getAppSettingsMock.mockResolvedValue(settings)
    getDirectoryHandleMock.mockResolvedValue(handle)
    queryDirectoryPermissionMock.mockResolvedValue('prompt')

    await bootstrapWorkspace(context)

    expect(getAppSettingsMock).toHaveBeenCalledWith(TEST_USER_ID)
    expect(getSyncStateMock).toHaveBeenCalledWith(TEST_USER_ID)
    expect(getDirectoryHandleMock).toHaveBeenCalledWith(TEST_USER_ID)
    expect(queryDirectoryPermissionMock).toHaveBeenCalledWith(handle)
    expect(context.setStorage).toHaveBeenCalledWith(null)
    expect(context.setReconnectableDirectoryName).toHaveBeenLastCalledWith('Notes')
    expect(context.refreshWorkspace).not.toHaveBeenCalled()
    expect(createDirectoryStorageMock).not.toHaveBeenCalled()
    expect(requestDirectoryPermissionMock).not.toHaveBeenCalled()
    expect(createOpfsStorageMock).not.toHaveBeenCalled()
  })

  it('keeps the saved handle pending reconnect when startup permission is denied', async () => {
    const settings = createSettings({
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    })
    const handle = { name: 'Notes' } as FileSystemDirectoryHandle
    const context = createContext(settings)

    getAppSettingsMock.mockResolvedValue(settings)
    getDirectoryHandleMock.mockResolvedValue(handle)
    queryDirectoryPermissionMock.mockResolvedValue('denied')

    await bootstrapWorkspace(context)

    expect(getAppSettingsMock).toHaveBeenCalledWith(TEST_USER_ID)
    expect(getSyncStateMock).toHaveBeenCalledWith(TEST_USER_ID)
    expect(getDirectoryHandleMock).toHaveBeenCalledWith(TEST_USER_ID)
    expect(queryDirectoryPermissionMock).toHaveBeenCalledWith(handle)
    expect(context.setStorage).toHaveBeenCalledWith(null)
    expect(context.setReconnectableDirectoryName).toHaveBeenLastCalledWith('Notes')
    expect(context.refreshWorkspace).not.toHaveBeenCalled()
    expect(createDirectoryStorageMock).not.toHaveBeenCalled()
    expect(requestDirectoryPermissionMock).not.toHaveBeenCalled()
    expect(createOpfsStorageMock).not.toHaveBeenCalled()
  })
})

describe('workspace attach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists the picked folder handle and activates directory storage', async () => {
    const settings = createSettings({
      backend: 'opfs',
      lastOpenedPath: 'notes/today.md',
    })
    const handle = { name: 'Notes' } as FileSystemDirectoryHandle
    const directoryStorage = createStorage('directory', 'Notes')
    const context = createContext(settings)

    vi.stubGlobal('window', {
      showDirectoryPicker: vi.fn(),
    })

    pickDirectoryHandleMock.mockResolvedValue(handle)
    requestDirectoryPermissionMock.mockResolvedValue(true)
    createDirectoryStorageMock.mockReturnValue(directoryStorage)

    await expect(attachFolder(context)).resolves.toBe(true)

    expect(pickDirectoryHandleMock).toHaveBeenCalledTimes(1)
    expect(requestDirectoryPermissionMock).toHaveBeenCalledWith(handle)
    expect(setDirectoryHandleMock).toHaveBeenCalledWith(TEST_USER_ID, handle)
    expect(createDirectoryStorageMock).toHaveBeenCalledWith(handle)
    expect(context.setErrorMessage).toHaveBeenCalledWith(null)
    expect(context.setReconnectableDirectoryName).toHaveBeenCalledWith(null)
    expect(context.setStorage).toHaveBeenCalledWith(directoryStorage)
    expect(context.saveSettings).toHaveBeenCalledWith(createSettings({
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    }))
    expect(context.refreshWorkspace).toHaveBeenCalledWith('notes/today.md')
    expect(context.focusEditor).toHaveBeenCalledTimes(1)
  })
})

describe('workspace reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws when no saved folder handle is available to reconnect', async () => {
    const context = createContext(createSettings({
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    }))

    getDirectoryHandleMock.mockResolvedValue(null)

    await expect(reconnectFolder(context)).rejects.toThrow('No saved folder is available to reconnect')
    expect(requestDirectoryPermissionMock).not.toHaveBeenCalled()
    expect(createDirectoryStorageMock).not.toHaveBeenCalled()
    expect(context.setStorage).not.toHaveBeenCalled()
  })

  it('reuses the saved folder handle on reconnect', async () => {
    const settings = createSettings({
      backend: 'directory',
      lastOpenedPath: 'notes/today.md',
    })
    const handle = { name: 'Notes' } as FileSystemDirectoryHandle
    const directoryStorage = createStorage('directory', 'Notes')
    const context = createContext(settings)

    getDirectoryHandleMock.mockResolvedValue(handle)
    requestDirectoryPermissionMock.mockResolvedValue(true)
    createDirectoryStorageMock.mockReturnValue(directoryStorage)

    await reconnectFolder(context)

    expect(getDirectoryHandleMock).toHaveBeenCalledTimes(1)
    expect(getDirectoryHandleMock).toHaveBeenCalledWith(TEST_USER_ID)
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
