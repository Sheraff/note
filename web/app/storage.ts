import type { AppSettings, SyncState } from '../schemas.ts'
import {
  createDirectoryStorage,
  pickDirectoryHandle,
  queryDirectoryPermission,
  requestDirectoryPermission,
} from '../storage/file-system-access.ts'
import {
  getAppSettings,
  getDirectoryHandle,
  getDirectoryStorageId,
  getSyncState,
  setDirectoryHandle,
  setDirectoryStorageId,
} from '../storage/metadata.ts'
import { createOpfsStorage } from '../storage/opfs.ts'
import { isDirectoryPickerSupported, type NoteStorage } from '../storage/types.ts'

export type StorageContext = {
  userId(): string
  settings(): AppSettings
  setSettings(nextSettings: AppSettings): void
  saveSettings?(nextSettings: AppSettings): Promise<void>
  updateSettings?(updater: (current: AppSettings) => AppSettings): Promise<AppSettings>
  setStorage(storage: NoteStorage | null): void
  setSyncState(syncState: SyncState): void
  setReconnectableDirectoryName(name: string | null): void
  setErrorMessage(message: string | null): void
  refreshWorkspace(preferredPath: string | null): Promise<void>
  focusEditor(): void
}

async function updateStoredSettings(
  context: Pick<StorageContext, 'saveSettings' | 'settings' | 'updateSettings'>,
  updater: (current: AppSettings) => AppSettings,
): Promise<AppSettings> {
  if (context.updateSettings !== undefined) {
    return context.updateSettings(updater)
  }

  const nextSettings = updater(context.settings())
  await context.saveSettings?.(nextSettings)
  return nextSettings
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function isSameDirectoryHandle(
  left: FileSystemDirectoryHandle | null,
  right: FileSystemDirectoryHandle,
): Promise<boolean> {
  if (left == null || typeof left.isSameEntry !== 'function') {
    return false
  }

  try {
    return await left.isSameEntry(right)
  } catch {
    return false
  }
}

async function ensureDirectoryStorageId(userId: string): Promise<string> {
  const existingStorageId = await getDirectoryStorageId(userId)

  if (existingStorageId !== null) {
    return existingStorageId
  }

  const nextStorageId = crypto.randomUUID()
  await setDirectoryStorageId(userId, nextStorageId)
  return nextStorageId
}

async function resolveDirectoryStorageId(userId: string, nextHandle: FileSystemDirectoryHandle): Promise<string> {
  const [savedHandle, savedStorageId] = await Promise.all([
    getDirectoryHandle(userId),
    getDirectoryStorageId(userId),
  ])

  if (savedStorageId !== null && (await isSameDirectoryHandle(savedHandle, nextHandle))) {
    return savedStorageId
  }

  const nextStorageId = crypto.randomUUID()
  await setDirectoryStorageId(userId, nextStorageId)
  return nextStorageId
}

async function activateStorage(
  context: StorageContext,
  nextStorage: NoteStorage,
  updateSettings: (current: AppSettings) => AppSettings,
) {
  context.setErrorMessage(null)
  context.setReconnectableDirectoryName(null)
  context.setStorage(nextStorage)
  const nextSettings = await updateStoredSettings(context, updateSettings)
  await context.refreshWorkspace(nextSettings.lastOpenedPath)
  context.focusEditor()
}

export async function bootstrapWorkspace(context: StorageContext) {
  const userId = context.userId()
  const savedSettings = await getAppSettings(userId)
  const savedSyncState = await getSyncState(userId)

  context.setSettings(savedSettings)
  context.setSyncState(savedSyncState)
  context.setReconnectableDirectoryName(null)

  if (savedSettings.backend !== 'directory') {
    context.setStorage(createOpfsStorage())
    await context.refreshWorkspace(savedSettings.lastOpenedPath)
    return
  }

  const handle = await getDirectoryHandle(userId)

  if (handle !== null && (await queryDirectoryPermission(handle)) === 'granted') {
    context.setStorage(createDirectoryStorage(handle, await ensureDirectoryStorageId(userId)))
    await context.refreshWorkspace(savedSettings.lastOpenedPath)
    return
  }

  context.setStorage(null)
  context.setReconnectableDirectoryName(handle?.name ?? null)
}

export async function pickFolderHandle(
  context: Pick<StorageContext, 'setErrorMessage'>,
): Promise<FileSystemDirectoryHandle | null> {
  if (!isDirectoryPickerSupported()) {
    context.setErrorMessage('This browser does not support the File System Access API.')
    return null
  }

  let handle: FileSystemDirectoryHandle

  try {
    handle = await pickDirectoryHandle()
  } catch (error) {
    if (isAbortError(error)) {
      return null
    }

    throw error
  }

  if (!(await requestDirectoryPermission(handle))) {
    throw new Error('Folder access was not granted')
  }

  return handle
}

export async function activateDirectoryHandle(context: StorageContext, handle: FileSystemDirectoryHandle) {
  const storageId = await resolveDirectoryStorageId(context.userId(), handle)
  await setDirectoryHandle(context.userId(), handle)
  await activateStorage(
    context,
    createDirectoryStorage(handle, storageId),
    (current) => ({
      ...current,
      backend: 'directory',
    }),
  )
}

export async function attachFolder(context: StorageContext): Promise<boolean> {
  const handle = await pickFolderHandle(context)

  if (handle === null) {
    return false
  }

  await activateDirectoryHandle(context, handle)

  return true
}

export async function reconnectFolder(context: StorageContext) {
  const userId = context.userId()
  const handle = await getDirectoryHandle(userId)

  if (handle === null) {
    throw new Error('No saved folder is available to reconnect')
  }

  if (!(await requestDirectoryPermission(handle))) {
    throw new Error('Folder access was not granted')
  }

  await activateStorage(
    context,
    createDirectoryStorage(handle, await ensureDirectoryStorageId(userId)),
    (current) => ({
      ...current,
      backend: 'directory',
    }),
  )
}

export async function switchToOpfs(context: StorageContext) {
  await activateStorage(
    context,
    createOpfsStorage(),
    (current) => ({
      ...current,
      backend: 'opfs',
    }),
  )
}
