import type { AppSettings, SyncState } from '../schemas.ts'
import {
  createDirectoryStorage,
  pickDirectoryHandle,
  queryDirectoryPermission,
  requestDirectoryPermission,
} from '../storage/file-system-access.ts'
import { getAppSettings, getDirectoryHandle, getSyncState, setDirectoryHandle } from '../storage/metadata.ts'
import { createOpfsStorage } from '../storage/opfs.ts'
import { isDirectoryPickerSupported, type NoteStorage } from '../storage/types.ts'

export type StorageContext = {
  settings(): AppSettings
  setSettings(nextSettings: AppSettings): void
  saveSettings(nextSettings: AppSettings): Promise<void>
  setStorage(storage: NoteStorage | null): void
  setSyncState(syncState: SyncState): void
  setReconnectableDirectoryName(name: string | null): void
  setErrorMessage(message: string | null): void
  refreshWorkspace(preferredPath: string | null): Promise<void>
  focusEditor(): void
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function activateStorage(
  context: StorageContext,
  nextStorage: NoteStorage,
  nextSettings: AppSettings,
) {
  context.setErrorMessage(null)
  context.setReconnectableDirectoryName(null)
  context.setStorage(nextStorage)
  await context.saveSettings(nextSettings)
  await context.refreshWorkspace(nextSettings.lastOpenedPath)
  context.focusEditor()
}

export async function bootstrapWorkspace(context: StorageContext) {
  const savedSettings = await getAppSettings()
  const savedSyncState = await getSyncState()

  context.setSettings(savedSettings)
  context.setSyncState(savedSyncState)
  context.setReconnectableDirectoryName(null)

  if (savedSettings.backend !== 'directory') {
    context.setStorage(createOpfsStorage())
    await context.refreshWorkspace(savedSettings.lastOpenedPath)
    return
  }

  const handle = await getDirectoryHandle()

  if (handle !== null && (await queryDirectoryPermission(handle)) === 'granted') {
    context.setStorage(createDirectoryStorage(handle))
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
  await setDirectoryHandle(handle)
  await activateStorage(
    context,
    createDirectoryStorage(handle),
    {
      ...context.settings(),
      backend: 'directory',
    },
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
  const handle = await getDirectoryHandle()

  if (handle === null) {
    throw new Error('No saved folder is available to reconnect')
  }

  if (!(await requestDirectoryPermission(handle))) {
    throw new Error('Folder access was not granted')
  }

  await activateStorage(
    context,
    createDirectoryStorage(handle),
    {
      ...context.settings(),
      backend: 'directory',
    },
  )
}

export async function switchToOpfs(context: StorageContext) {
  await activateStorage(
    context,
    createOpfsStorage(),
    {
      ...context.settings(),
      backend: 'opfs',
    },
  )
}
