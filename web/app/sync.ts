import { createApiClient } from '../api.ts'
import type { SyncState } from '../schemas.ts'
import { syncWithServer } from '../notes/sync.ts'
import { setSyncState } from '../storage/metadata.ts'
import type { NoteStorage } from '../storage/types.ts'

const api = createApiClient()

export type SyncRequestOptions = {
  skipPendingSave?: boolean
}

export type FlushPendingSaveOptions = {
  force?: boolean
}

export type SyncContext = {
  storage(): NoteStorage | null
  syncState(): SyncState
  currentPath(): string | null
  setSyncState(syncState: SyncState): void
  setIsSyncing(value: boolean): void
  setErrorMessage(message: string | null): void
  flushPendingSave(options?: FlushPendingSaveOptions): Promise<boolean>
  refreshWorkspace(preferredPath: string | null): Promise<void>
}

export function createSyncRequester(options: {
  onError(error: unknown): void
  runSync(options: Required<SyncRequestOptions>): Promise<void>
}) {
  let isQueued = false
  let shouldFlushPendingSave = false
  let inFlight: Promise<void> | null = null

  return function requestSync(request: SyncRequestOptions = {}): Promise<void> {
    isQueued = true
    shouldFlushPendingSave ||= request.skipPendingSave !== true

    if (inFlight !== null) {
      return inFlight
    }

    inFlight = (async () => {
      while (isQueued) {
        const skipPendingSave = !shouldFlushPendingSave
        isQueued = false
        shouldFlushPendingSave = false

        try {
          await options.runSync({ skipPendingSave })
        } catch (error) {
          options.onError(error)
        }
      }
    })().finally(() => {
      inFlight = null
    })

    return inFlight
  }
}

export async function syncNow(context: SyncContext, options: SyncRequestOptions = {}) {
  const currentStorage = context.storage()

  if (currentStorage === null) {
    return
  }

  context.setErrorMessage(null)
  context.setIsSyncing(true)

  try {
    if (options.skipPendingSave !== true) {
      await context.flushPendingSave({ force: true })
    }

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
