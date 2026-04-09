import * as v from 'valibot'
import {
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  DEFAULT_SYNC_STATE,
  DirectoryHandleSchema,
  SyncStateSchema,
  type AppSettings,
  type SyncState,
} from '../schemas.ts'

const DATABASE_NAME = 'note-metadata'
const DATABASE_VERSION = 2
const SETTINGS_STORE = 'settings'
const HANDLES_STORE = 'handles'
const SYNC_STORE = 'sync'
const LOCAL_FILE_INDEX_STORE = 'local-file-index'
const APP_SETTINGS_KEY = 'app-settings'
const DIRECTORY_HANDLE_KEY = 'directory-handle'
const DIRECTORY_STORAGE_ID_KEY = 'directory-storage-id'
const SYNC_STATE_KEY = 'sync-state'

const LocalFileIndexEntrySchema = v.object({
  path: v.string(),
  contentHash: v.string(),
  updatedAt: v.string(),
  size: v.pipe(v.number(), v.integer(), v.minValue(0)),
  lastModified: v.pipe(v.number(), v.integer(), v.minValue(0)),
  format: v.picklist(['text', 'binary']),
  mimeType: v.nullable(v.string()),
})

const DirectoryStorageIdSchema = v.pipe(v.string(), v.minLength(1))

export type LocalFileIndexEntry = v.InferOutput<typeof LocalFileIndexEntrySchema>

function getScopedKey(userId: string, key: string): string {
  return `${userId}:${key}`
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }

    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }

    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    }
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result

      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE)
      }

      if (!database.objectStoreNames.contains(HANDLES_STORE)) {
        database.createObjectStore(HANDLES_STORE)
      }

      if (!database.objectStoreNames.contains(SYNC_STORE)) {
        database.createObjectStore(SYNC_STORE)
      }

      if (!database.objectStoreNames.contains(LOCAL_FILE_INDEX_STORE)) {
        database.createObjectStore(LOCAL_FILE_INDEX_STORE)
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error ?? new Error('Unable to open IndexedDB'))
    }
  })
}

async function readValue(storeName: string, key: string): Promise<unknown> {
  const database = await openDatabase()
  const transaction = database.transaction(storeName, 'readonly')
  const store = transaction.objectStore(storeName)
  const value = await requestToPromise(store.get(key))
  await transactionToPromise(transaction)
  database.close()
  return value
}

async function writeValue(storeName: string, key: string, value: unknown): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(storeName, 'readwrite')
  const store = transaction.objectStore(storeName)
  await requestToPromise(store.put(value, key))
  await transactionToPromise(transaction)
  database.close()
}

export async function getAppSettings(userId: string): Promise<AppSettings> {
  const value = await readValue(SETTINGS_STORE, getScopedKey(userId, APP_SETTINGS_KEY))

  if (value === undefined) {
    return DEFAULT_APP_SETTINGS
  }

  const partialSettings = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const partialOpenDirectoryPaths =
    partialSettings.openDirectoryPaths !== null && typeof partialSettings.openDirectoryPaths === 'object'
      ? partialSettings.openDirectoryPaths as Record<string, unknown>
      : {}

  return v.parse(AppSettingsSchema, {
    ...DEFAULT_APP_SETTINGS,
    ...partialSettings,
    openDirectoryPaths: {
      ...DEFAULT_APP_SETTINGS.openDirectoryPaths,
      ...partialOpenDirectoryPaths,
    },
  })
}

export async function setAppSettings(userId: string, settings: AppSettings): Promise<void> {
  await writeValue(SETTINGS_STORE, getScopedKey(userId, APP_SETTINGS_KEY), v.parse(AppSettingsSchema, settings))
}

export async function getDirectoryHandle(userId: string): Promise<FileSystemDirectoryHandle | null> {
  const value = await readValue(HANDLES_STORE, getScopedKey(userId, DIRECTORY_HANDLE_KEY))

  if (value === undefined) {
    return null
  }

  return v.parse(v.nullable(DirectoryHandleSchema), value)
}

export async function setDirectoryHandle(userId: string, handle: FileSystemDirectoryHandle | null): Promise<void> {
  await writeValue(HANDLES_STORE, getScopedKey(userId, DIRECTORY_HANDLE_KEY), v.parse(v.nullable(DirectoryHandleSchema), handle))
}

export async function getDirectoryStorageId(userId: string): Promise<string | null> {
  const value = await readValue(HANDLES_STORE, getScopedKey(userId, DIRECTORY_STORAGE_ID_KEY))

  if (value === undefined) {
    return null
  }

  return v.parse(v.nullable(DirectoryStorageIdSchema), value)
}

export async function setDirectoryStorageId(userId: string, storageId: string | null): Promise<void> {
  await writeValue(HANDLES_STORE, getScopedKey(userId, DIRECTORY_STORAGE_ID_KEY), v.parse(v.nullable(DirectoryStorageIdSchema), storageId))
}

export async function getSyncState(userId: string): Promise<SyncState> {
  const value = await readValue(SYNC_STORE, getScopedKey(userId, SYNC_STATE_KEY))

  if (value === undefined) {
    return DEFAULT_SYNC_STATE
  }

  const partialSyncState = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}

  return v.parse(SyncStateSchema, {
    ...DEFAULT_SYNC_STATE,
    ...partialSyncState,
  })
}

export async function setSyncState(userId: string, syncState: SyncState): Promise<void> {
  await writeValue(SYNC_STORE, getScopedKey(userId, SYNC_STATE_KEY), v.parse(SyncStateSchema, syncState))
}

export async function getLocalFileIndex(storageCacheKey: string): Promise<LocalFileIndexEntry[]> {
  const value = await readValue(LOCAL_FILE_INDEX_STORE, storageCacheKey)

  if (value === undefined) {
    return []
  }

  return v.parse(v.array(LocalFileIndexEntrySchema), value)
}

export async function setLocalFileIndex(storageCacheKey: string, entries: LocalFileIndexEntry[]): Promise<void> {
  await writeValue(LOCAL_FILE_INDEX_STORE, storageCacheKey, v.parse(v.array(LocalFileIndexEntrySchema), entries))
}
