import { createApiClient } from '#web/api.ts'
import type { NoteConflict, SaveCurrentNoteResult } from './notes.ts'
import type { SyncState } from '#web/schemas.ts'
import { doesManifestMatchSyncState, syncWithServer } from '#web/notes/sync.ts'
import { setSyncState } from '#web/storage/metadata.ts'
import type { NoteStorage, StoredFile } from '#web/storage/types.ts'

const api = createApiClient()

export type SyncMode = 'full' | 'precheck-if-clean'

export type SyncRequestOptions = {
  mode?: SyncMode
  skipPendingSave?: boolean
}

export type FlushPendingSaveOptions = {
  force?: boolean
}

export type FlushPendingSaveResult = SaveCurrentNoteResult | { status: 'skipped' }

export type SyncContext = {
  blockedSyncPaths(): string[]
  storage(): NoteStorage | null
  syncState(): SyncState
  currentPath(): string | null
  setQueuedNoteConflicts(conflicts: NoteConflict[]): void
  setSyncState(syncState: SyncState): void
  setIsSyncing(value: boolean): void
  hasKnownLocalChangesSinceSync(): boolean
  setHasKnownLocalChangesSinceSync(value: boolean): void
  setErrorMessage(message: string | null): void
  setNoteConflict(conflict: NoteConflict | null): void
  flushPendingSave(options?: FlushPendingSaveOptions): Promise<FlushPendingSaveResult>
  refreshWorkspace(preferredPath: string | null): Promise<void>
}

function mergeSyncMode(left: SyncMode | null, right: SyncMode): SyncMode {
  if (left === 'full' || right === 'full') {
    return 'full'
  }

  return 'precheck-if-clean'
}

async function persistSyncState(context: SyncContext, syncState: SyncState): Promise<void> {
  context.setSyncState(syncState)
  await setSyncState(syncState)
}

function createSyncNoteConflict(path: string, mineFile: StoredFile | null, theirsFile: StoredFile | null): NoteConflict {
  return {
    path,
    preferredMode: 'popover',
    draftContent: mineFile?.content ?? '',
    diskFile: theirsFile,
    loadedSnapshot: mineFile,
    source: 'remote',
  }
}

async function writeConflictSourceVersion(storage: NoteStorage, conflict: NoteConflict): Promise<void> {
  if (conflict.diskFile !== null) {
    await storage.writeTextFile(conflict.path, conflict.diskFile.content)
    return
  }

  await storage.deleteEntry(conflict.path)
}

async function runFullSync(context: SyncContext, storage: NoteStorage): Promise<{
  syncState: SyncState
  conflict: NoteConflict | null
}> {
  const blockedPaths = new Set(context.blockedSyncPaths())
  const result = await syncWithServer({
    api,
    blockedPaths,
    previousState: context.syncState(),
    storage,
  })
  const firstConflict = result.conflicts[0] ?? null
  let noteConflict: NoteConflict | null = null

  await persistSyncState(context, result.syncState)

  if (firstConflict !== null) {
    await context.refreshWorkspace(firstConflict.path)

    const noteConflicts: NoteConflict[] = []

    for (const conflict of result.conflicts) {
      noteConflicts.push(createSyncNoteConflict(conflict.path, await storage.readTextFile(conflict.path), conflict.theirsFile))
    }

    for (const queuedConflict of noteConflicts.slice(1)) {
      await writeConflictSourceVersion(storage, queuedConflict)
    }

    noteConflict = noteConflicts[0] ?? null
    context.setNoteConflict(noteConflict)
    context.setQueuedNoteConflicts(noteConflicts.slice(1))
    context.setHasKnownLocalChangesSinceSync(true)

    if (result.conflicts.length > 1) {
      context.setErrorMessage(`Multiple sync conflicts detected. Resolve ${firstConflict.path} first.`)
    }

    return {
      syncState: result.syncState,
      conflict: noteConflict,
    }
  }

  if (blockedPaths.size === 0) {
    context.setQueuedNoteConflicts([])
    context.setNoteConflict(null)
    context.setHasKnownLocalChangesSinceSync(false)
  } else {
    context.setHasKnownLocalChangesSinceSync(true)
  }

  await context.refreshWorkspace(context.currentPath())

  return {
    syncState: result.syncState,
    conflict: null,
  }
}

export function createSyncRequester(options: {
  onError(error: unknown): void
  runSync(options: { mode: SyncMode; skipPendingSave: boolean }): Promise<void>
}) {
  let isQueued = false
  let shouldFlushPendingSave = false
  let queuedMode: SyncMode | null = null
  let inFlight: Promise<void> | null = null

  return function requestSync(request: SyncRequestOptions = {}): Promise<void> {
    const mode = request.mode ?? 'full'

    isQueued = true
    shouldFlushPendingSave ||= request.skipPendingSave !== true
    queuedMode = mergeSyncMode(queuedMode, mode)

    if (inFlight !== null) {
      return inFlight
    }

    inFlight = (async () => {
      while (isQueued) {
        const skipPendingSave = !shouldFlushPendingSave
        const mode = queuedMode ?? 'full'

        isQueued = false
        shouldFlushPendingSave = false
        queuedMode = null

        try {
          await options.runSync({ mode, skipPendingSave })
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
  const mode = options.mode ?? 'full'

  if (currentStorage === null) {
    return
  }

  context.setErrorMessage(null)
  context.setIsSyncing(true)

  try {
    if (options.skipPendingSave !== true) {
      const saveResult = await context.flushPendingSave({ force: true })

      if (saveResult.status === 'conflict') {
        return
      }
    }

    if (mode === 'precheck-if-clean' && !context.hasKnownLocalChangesSinceSync()) {
      const manifest = await api.getManifest()

      if (doesManifestMatchSyncState(manifest.files, context.syncState().files)) {
        await persistSyncState(context, {
          ...context.syncState(),
          lastSyncedAt: new Date().toISOString(),
        })
        context.setNoteConflict(null)
        return
      }
    }

    await runFullSync(context, currentStorage)
  } finally {
    context.setIsSyncing(false)
  }
}
