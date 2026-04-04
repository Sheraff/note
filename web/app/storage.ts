import type { AppSettings, SyncState } from '../schemas.ts'
import {
  createDirectoryStorage,
  hasDirectoryPermission,
  pickDirectoryHandle,
} from '../storage/file-system-access.ts'
import { getAppSettings, getDirectoryHandle, getSyncState, setDirectoryHandle } from '../storage/metadata.ts'
import { createOpfsStorage } from '../storage/opfs.ts'
import { isDirectoryPickerSupported, type NoteStorage } from '../storage/types.ts'

export type StorageContext = {
  settings(): AppSettings
  setSettings(nextSettings: AppSettings): void
  saveSettings(nextSettings: AppSettings): Promise<void>
  setStorage(storage: NoteStorage): void
  setSyncState(syncState: SyncState): void
  setErrorMessage(message: string | null): void
  refreshWorkspace(preferredPath: string | null): Promise<void>
  focusEditor(): void
}

async function activateStorage(
  context: StorageContext,
  nextStorage: NoteStorage,
  nextSettings: AppSettings,
) {
  context.setErrorMessage(null)
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

  if (savedSettings.backend !== 'directory') {
    context.setStorage(createOpfsStorage())
    await context.refreshWorkspace(savedSettings.lastOpenedPath)
    return
  }

  const handle = await getDirectoryHandle()

  if (handle !== null && (await hasDirectoryPermission(handle))) {
    context.setStorage(createDirectoryStorage(handle))
    await context.refreshWorkspace(savedSettings.lastOpenedPath)
    return
  }

  await activateStorage(
    context,
    createOpfsStorage(),
    {
      ...savedSettings,
      backend: 'opfs',
    },
  )
}

export async function attachFolder(context: StorageContext) {
  if (!isDirectoryPickerSupported()) {
    context.setErrorMessage('This browser does not support the File System Access API.')
    return
  }

  const handle = await pickDirectoryHandle()

  if (!(await hasDirectoryPermission(handle))) {
    throw new Error('Folder access was not granted')
  }

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
