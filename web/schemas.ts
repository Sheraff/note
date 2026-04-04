import * as v from 'valibot'
import { NotePathSchema, RemoteFileSchema } from '../server/schemas.ts'

function isDirectoryHandle(input: unknown): input is FileSystemDirectoryHandle {
  return (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    input.kind === 'directory' &&
    'name' in input &&
    typeof input.name === 'string' &&
    'queryPermission' in input &&
    typeof input.queryPermission === 'function'
  )
}

export const StorageBackendSchema = v.picklist(['opfs', 'directory'])

export const AppSettingsSchema = v.object({
  backend: StorageBackendSchema,
  lastOpenedPath: v.nullable(NotePathSchema),
})

export const SyncStateSchema = v.object({
  files: v.array(RemoteFileSchema),
  lastSyncedAt: v.nullable(v.string()),
})

export const DirectoryHandleSchema = v.custom<FileSystemDirectoryHandle>(isDirectoryHandle)

export type StorageBackend = v.InferOutput<typeof StorageBackendSchema>
export type AppSettings = v.InferOutput<typeof AppSettingsSchema>
export type SyncState = v.InferOutput<typeof SyncStateSchema>

export const DEFAULT_APP_SETTINGS: AppSettings = {
  backend: 'opfs',
  lastOpenedPath: null,
}

export const DEFAULT_SYNC_STATE: SyncState = {
  files: [],
  lastSyncedAt: null,
}
