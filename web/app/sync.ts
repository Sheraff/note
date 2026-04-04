import { createApiClient } from '../api.ts'
import type { SyncState } from '../schemas.ts'
import { syncWithServer } from '../notes/sync.ts'
import { setSyncState } from '../storage/metadata.ts'
import type { NoteStorage } from '../storage/types.ts'

const api = createApiClient()

export type SyncContext = {
  storage(): NoteStorage | null
  syncState(): SyncState
  currentPath(): string | null
  setSyncState(syncState: SyncState): void
  setIsSyncing(value: boolean): void
  setErrorMessage(message: string | null): void
  flushPendingSave(): Promise<void>
  refreshWorkspace(preferredPath: string | null): Promise<void>
}

export async function syncNow(context: SyncContext) {
  const currentStorage = context.storage()

  if (currentStorage === null) {
    return
  }

  context.setErrorMessage(null)
  context.setIsSyncing(true)

  try {
    await context.flushPendingSave()
    const nextSyncState = await syncWithServer({
      api,
      previousState: context.syncState(),
      storage: currentStorage,
    })
    context.setSyncState(nextSyncState)
    await setSyncState(nextSyncState)
    await context.refreshWorkspace(context.currentPath())
  } finally {
    context.setIsSyncing(false)
  }
}
