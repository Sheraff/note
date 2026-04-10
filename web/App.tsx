import { createMultiHotkeyHandler } from '@tanstack/hotkeys'
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js'
import { EditorPane } from './app/EditorPane.tsx'
import type { EntryEditorSubmitSource } from './app/FileTree.tsx'
import { NotesSidebar } from './app/NotesSidebar.tsx'
import { StatusBar } from './app/StatusBar.tsx'
import type { ConflictActionLabels } from './app/ConflictActions.tsx'
import {
  createFolder,
  createNote,
  deleteEntry,
  loadNote,
  moveEntry,
  refreshWorkspace as refreshWorkspaceState,
  renameEntry,
  saveCurrentNote,
  type NoteConflict,
  type NoteContext,
  type OpenNoteSyncSnapshot,
  type RefreshWorkspaceOptions,
  type SaveCurrentNoteResult,
} from './app/notes.ts'
import {
  activateDirectoryHandle,
  bootstrapWorkspace,
  pickFolderHandle,
  reconnectFolder,
  switchToOpfs,
  type StorageContext,
} from './app/storage.ts'
import {
  createSyncRequester,
  syncNow,
  type FlushPendingSaveResult,
  type SyncContext,
} from './app/sync.ts'
import { createApiClient, isAuthRedirectError } from './api.ts'
import type { MonacoController } from './editor/monaco.ts'
import { createConflictCopyPath } from './notes/paths.ts'
import { buildTree } from './notes/tree.ts'
import { DEFAULT_APP_SETTINGS, DEFAULT_SYNC_STATE, type AppSettings, type SyncState } from './schemas.ts'
import { getStoredFileViewKind } from './storage/file-classify.ts'
import { getFileTypeLabel } from './storage/file-paths.ts'
import { setAppSettings, setSyncState as persistSyncState } from './storage/metadata.ts'
import { createDirectoryStorage } from './storage/file-system-access.ts'
import { createOpfsStorage } from './storage/opfs.ts'
import {
  copyStorageEntries,
  getStorageTransferConflicts,
  replaceStorageEntries,
  type StorageTransferConflict,
} from './storage/transfer.ts'
import {
  isRemoteBlobFile,
  isTextStoredFile,
  toWriteFileInput,
  writeStoredFile,
  type ListedEntry,
  type NoteStorage,
  type StoredFile,
} from './storage/types.ts'
import './App.css'

const AUTO_SYNC_COOLDOWN_MS = 10_000
const AUTO_SYNC_INTERVAL_MS = 60_000
const ACTIVE_CONFLICT_MESSAGE = 'Resolve the open note conflict before continuing.'

type EditorMode = 'plain' | 'diff'
type PersistResult = SaveCurrentNoteResult | FlushPendingSaveResult
const api = createApiClient()

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}

function shouldSyncAfterSaveResult(result: PersistResult): boolean {
  return result.status === 'saved' || result.status === 'reloaded'
}

function isSaveBlockedByConflict(result: PersistResult): boolean {
  return result.status === 'conflict'
}

function getConflictOriginalLabel(conflict: NoteConflict): string {
  return conflict.source === 'remote' ? 'Cloud version' : 'File version'
}

function getConflictSourceActionLabel(conflict: NoteConflict, action: 'accept' | 'save'): string {
  const prefix = action === 'accept' ? 'Accept' : 'Save'
  const sourceLabel = conflict.source === 'remote' ? 'cloud' : 'file'

  return conflict.diskFile === null ? `${prefix} ${sourceLabel} deletion` : `${prefix} ${sourceLabel} version`
}

function getOpfsTransferPrompt(directoryName: string): string {
  return `Transfer existing OPFS notes and folders to ${directoryName} before switching?`
}

function getStorageTransferConflictMessage(directoryName: string, conflict: StorageTransferConflict): string {
  return `Can't transfer OPFS notes because ${conflict.path} already exists in ${directoryName}.`
}

function arePathArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

function App() {
  let editorElement: HTMLDivElement | undefined
  let editor: MonacoController | undefined
  let editorMode: EditorMode = 'plain'
  let activeEditorPath: string | null = null
  let saveTimeout: number | undefined
  let autoSyncInterval: number | undefined
  let activeSyncOpenNoteSnapshots: Map<string, OpenNoteSyncSnapshot> | null = null
  let lastAutoSyncAt = 0
  let settingsUpdateQueue = Promise.resolve()

  const [sidebarWidth, setSidebarWidth] = createSignal(300)

  const [hasBootstrapped, setHasBootstrapped] = createSignal(false)
  const [userId, setUserId] = createSignal<string | null>(null)
  const [storage, setStorage] = createSignal<NoteStorage | null>(null)
  const [reconnectableDirectoryName, setReconnectableDirectoryName] = createSignal<string | null>(null)
  const [settings, setSettings] = createSignal<AppSettings>(DEFAULT_APP_SETTINGS)
  const [entries, setEntries] = createSignal<ListedEntry[]>([])
  const [currentPath, setCurrentPath] = createSignal<string | null>(null)
  const [draftContent, setDraftContent] = createSignal('')
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [syncState, setSyncStateSignal] = createSignal<SyncState>(DEFAULT_SYNC_STATE)
  const [isSyncing, setIsSyncing] = createSignal(false)
  const [loadedFileSnapshot, setLoadedFileSnapshot] = createSignal<StoredFile | null>(null)
  const [noteConflictSignal, setNoteConflictSignal] = createSignal<NoteConflict | null>(null)
  const [queuedNoteConflictsSignal, setQueuedNoteConflictsSignal] = createSignal<NoteConflict[]>([])
  const [isDiffMode, setIsDiffMode] = createSignal(false)
  const [hasUnsyncedWorkspaceChanges, setHasUnsyncedWorkspaceChanges] = createSignal(false)
  const [editorLanguageId, setEditorLanguageId] = createSignal<string | null>(null)

  const tree = createMemo(() => buildTree(entries()))
  const fileCount = createMemo(() => entries().filter((entry) => entry.kind === 'file').length)
  const hasUnsavedDraftChanges = createMemo(() => {
    if (currentPath() === null) {
      return false
    }

    const snapshot = loadedFileSnapshot()

    if (snapshot === null) {
      return draftContent().length > 0
    }

    if (!isTextStoredFile(snapshot)) {
      return false
    }

    return draftContent() !== snapshot.content
  })
  const hasKnownLocalChangesSinceSync = createMemo(() => hasUnsyncedWorkspaceChanges() || hasUnsavedDraftChanges())
  const unsavedPath = createMemo(() => {
    const path = currentPath()

    if (path === null || !hasUnsavedDraftChanges() || noteConflict()?.path === path) {
      return null
    }

    return path
  })
  const storageLabel = createMemo(() => {
    const currentStorage = storage()

    if (currentStorage !== null) {
      return currentStorage.label
    }

    const directoryName = reconnectableDirectoryName()

    if (directoryName !== null) {
      return `Reconnect ${directoryName}`
    }

    return hasBootstrapped() ? 'Attach folder' : 'Loading...'
  })
  const emptyMessage = createMemo(() => {
    const directoryName = reconnectableDirectoryName()

    if (directoryName !== null) {
      return `Reconnect ${directoryName} to reopen your notes.`
    }

    if (storage() === null && hasBootstrapped()) {
      return 'Attach a folder to reopen your notes.'
    }

    return 'Create a note to start writing.'
  })
  const isOpfsActive = createMemo(() => settings().backend === 'opfs')
  const currentFileViewKind = createMemo(() => {
    const file = loadedFileSnapshot()
    return file === null ? null : getStoredFileViewKind(file)
  })
  const diffSourceVersionLabel = createMemo(() => {
    const conflict = noteConflictSignal()

    return conflict === null ? 'Save source version' : getConflictSourceActionLabel(conflict, 'save')
  })
  const conflictSummary = createMemo(() => {
    const conflict = noteConflictSignal()

    if (conflict === null) {
      return null
    }

    const acceptTheirs = getConflictSourceActionLabel(conflict, 'accept')

    const message =
      conflict.source === 'remote'
        ? `Cloud conflict: ${conflict.path}`
        : `File conflict: ${conflict.path}`

    return {
      labels: {
        acceptTheirs,
        resolveInDiff: conflict.kind === 'text' ? 'Resolve conflicting changes' : null,
        saveMine: conflict.kind === 'text' ? 'Save my current draft' : 'Keep my local version',
        saveMineSeparately:
          conflict.kind === 'text' ? 'Save my current draft separately' : 'Save my local version separately',
      } satisfies ConflictActionLabels,
      message,
      path: conflict.path,
      diskFileExists: conflict.diskFile !== null,
    }
  })
  const conflictPaths = createMemo(() => blockedSyncPaths())

  function requireUserId(): string {
    const currentUserId = userId()

    if (currentUserId === null) {
      throw new Error('User session is not ready yet.')
    }

    return currentUserId
  }

  function reportError(error: unknown) {
    if (isAuthRedirectError(error)) {
      return
    }

    setErrorMessage(getErrorMessage(error))
  }

  function setNoteConflict(nextConflict: NoteConflict | null) {
    setNoteConflictSignal(nextConflict)

    if ((nextConflict === null || nextConflict.kind !== 'text') && isDiffMode()) {
      setIsDiffMode(false)
      void mountEditor('plain').catch(reportError)
    }
  }

  function noteConflict() {
    return noteConflictSignal()
  }

  function queuedNoteConflicts() {
    return queuedNoteConflictsSignal()
  }

  function blockedSyncPaths() {
    const paths = new Set<string>()
    const currentConflict = noteConflict()

    if (currentConflict !== null) {
      paths.add(currentConflict.path)
    }

    for (const conflict of queuedNoteConflicts()) {
      paths.add(conflict.path)
    }

    return [...paths]
  }

  function updateNoteConflict(updater: (conflict: NoteConflict) => NoteConflict) {
    const conflict = noteConflict()

    if (conflict === null) {
      return
    }

    setNoteConflictSignal(updater(conflict))
  }

  function beginSyncOpenNoteTracking() {
    activeSyncOpenNoteSnapshots = new Map()
    snapshotCurrentOpenNoteForSync()
  }

  function endSyncOpenNoteTracking() {
    activeSyncOpenNoteSnapshots = null
  }

  function snapshotCurrentOpenNoteForSync() {
    const path = currentPath()
    const file = loadedFileSnapshot()

    if (
      activeSyncOpenNoteSnapshots === null ||
      path === null ||
      !isTextStoredFile(file) ||
      activeSyncOpenNoteSnapshots.has(path)
    ) {
      return
    }

    activeSyncOpenNoteSnapshots.set(path, {
      path,
      content: draftContent(),
    })
  }

  function getSyncRefreshOptions(preferredPath: string | null): RefreshWorkspaceOptions {
    const snapshotPath = preferredPath ?? currentPath()

    return {
      openNoteSyncSnapshot:
        snapshotPath === null ? null : (activeSyncOpenNoteSnapshots?.get(snapshotPath) ?? null),
    }
  }

  function syncConflictDraft(value: string) {
    const conflict = noteConflict()

    if (conflict === null || conflict.kind !== 'text' || conflict.path !== currentPath()) {
      return
    }

    setNoteConflictSignal({
      ...conflict,
      draftContent: value,
    })
  }

  function updateSettings(updater: (current: AppSettings) => AppSettings): Promise<AppSettings> {
    const runUpdate = settingsUpdateQueue.catch(() => undefined).then(async () => {
      const nextSettings = updater(settings())

      setSettings(nextSettings)
      await setAppSettings(requireUserId(), nextSettings)
      return nextSettings
    })

    settingsUpdateQueue = runUpdate.then(() => undefined, () => undefined)
    return runUpdate
  }

  function trackSaveResult(result: PersistResult) {
    if (result.status === 'saved' || result.status === 'reloaded') {
      setHasUnsyncedWorkspaceChanges(true)
    }
  }

  async function refreshWorkspace(preferredPath: string | null, options: RefreshWorkspaceOptions = {}) {
    await refreshWorkspaceState(noteContext, preferredPath, options)
    editor?.refresh()
  }

  async function mountEditor(mode: EditorMode = 'plain') {
    if (editorElement === undefined) {
      return
    }

    const conflict = noteConflict()
    const nextMode = mode === 'diff' && conflict?.kind === 'text' ? 'diff' : 'plain'
    const nextEditorPath = nextMode === 'diff' ? (conflict?.path ?? currentPath()) : currentPath()
    const loadedFile = loadedFileSnapshot()

    if (nextMode === 'plain' && nextEditorPath !== null && loadedFile !== null && !isTextStoredFile(loadedFile)) {
      editor?.dispose()
      editor = undefined
      editorMode = 'plain'
      activeEditorPath = nextEditorPath
      setEditorLanguageId(getFileTypeLabel(loadedFile.path, loadedFile.mimeType))
      return
    }

    if (editor !== undefined && editorMode === nextMode && activeEditorPath === nextEditorPath) {
      editor.setPath(nextEditorPath)
      editor.setValue(draftContent())
      editor.refresh()
      setEditorLanguageId(editor.getLanguageId())
      return
    }

    editor?.dispose()
    editor = undefined
    activeEditorPath = null

    const monaco = await import('./editor/monaco.ts')

    if (nextMode === 'diff') {
      if (conflict === null || conflict.kind !== 'text') {
        editorMode = 'plain'
        await mountEditor('plain')
        return
      }

      editor = monaco.createMonacoDiffEditor(editorElement, {
        originalValue: conflict.diskFile?.content ?? '',
        modifiedValue: draftContent(),
        path: conflict.path,
        originalLabel: getConflictOriginalLabel(conflict),
        modifiedLabel: 'Current draft',
        onChange(value) {
          setDraftContent(value)
          syncConflictDraft(value)
        },
      })
      editorMode = 'diff'
      activeEditorPath = conflict.path
      setEditorLanguageId(editor.getLanguageId())
      return
    }

    editor = monaco.createMonacoEditor(editorElement, {
      initialValue: draftContent(),
      path: currentPath(),
      async readFile(path) {
        const currentStorage = storage()
        return currentStorage === null ? null : currentStorage.readFile(path)
      },
      onChange(value) {
        setDraftContent(value)
        syncConflictDraft(value)

        if (noteConflict()?.path !== currentPath()) {
          scheduleSave()
        }
      },
    })
    editorMode = 'plain'
    activeEditorPath = currentPath()
    setEditorLanguageId(editor.getLanguageId())
  }

  const noteContext: NoteContext = {
    storage,
    entries,
    currentPath,
    noteConflict,
    setCurrentPath,
    draftContent,
    setDraftContent,
    settings,
    updateSettings,
    setEntries,
    setErrorMessage,
    setEditorValue(value) {
      const path = currentPath()

      if (loadedFileSnapshot() !== null && !isTextStoredFile(loadedFileSnapshot())) {
        setEditorLanguageId(getFileTypeLabel(path ?? 'file', loadedFileSnapshot()?.mimeType ?? null))
        return
      }

      editor?.setPath(path)
      activeEditorPath = path
      setEditorLanguageId(editor?.getLanguageId() ?? null)
      editor?.setValue(value)
    },
    loadedFileSnapshot,
    setLoadedFileSnapshot,
    setNoteConflict,
  }

  const storageContext: StorageContext = {
    userId: requireUserId,
    settings,
    setSettings,
    updateSettings,
    setStorage,
    setSyncState: setSyncStateSignal,
    setReconnectableDirectoryName,
    setErrorMessage,
    refreshWorkspace(preferredPath) {
      return refreshWorkspace(preferredPath)
    },
    focusEditor() {
      editor?.focus()
    },
  }

  const syncContext: SyncContext = {
    userId: requireUserId,
    blockedSyncPaths,
    storage,
    syncState,
    currentPath,
    setQueuedNoteConflicts: setQueuedNoteConflictsSignal,
    setSyncState: setSyncStateSignal,
    setIsSyncing,
    hasKnownLocalChangesSinceSync,
    setHasKnownLocalChangesSinceSync: setHasUnsyncedWorkspaceChanges,
    setErrorMessage,
    setNoteConflict,
    flushPendingSave,
    refreshWorkspace(preferredPath) {
      return refreshWorkspace(preferredPath, getSyncRefreshOptions(preferredPath))
    },
  }

  const requestSync = createSyncRequester({
    onError: reportError,
    async runSync(options) {
      const previousLastSyncedAt = syncState().lastSyncedAt

      beginSyncOpenNoteTracking()

      try {
        await syncNow(syncContext, options)

        if (syncState().lastSyncedAt !== previousLastSyncedAt) {
          lastAutoSyncAt = Date.now()
        }
      } finally {
        endSyncOpenNoteTracking()
      }
    },
  })

  createEffect(
    on(
      [
        currentPath,
        () => loadedFileSnapshot()?.contentHash ?? null,
        () => loadedFileSnapshot()?.format ?? null,
        isDiffMode,
        () => noteConflictSignal()?.path ?? null,
        () => noteConflictSignal()?.kind ?? null,
      ],
      () => {
        void mountEditor(isDiffMode() ? 'diff' : 'plain').catch(reportError)
      },
      { defer: true },
    ),
  )

  function clearPendingSave() {
    if (saveTimeout === undefined) {
      return false
    }

    window.clearTimeout(saveTimeout)
    saveTimeout = undefined
    return true
  }

  async function reopenConflictNote(path: string) {
    const conflict = noteConflict()

    if (conflict === null || conflict.path !== path) {
      await loadNote(noteContext, path)
      snapshotCurrentOpenNoteForSync()
      return
    }

    clearPendingSave()
    setErrorMessage(null)
    setCurrentPath(conflict.path)
    setDraftContent(conflict.kind === 'text' ? conflict.draftContent : '')
    setLoadedFileSnapshot(conflict.loadedSnapshot)
    editor?.setValue(conflict.kind === 'text' ? conflict.draftContent : '')
    snapshotCurrentOpenNoteForSync()
    await updateSettings((current) => ({
      ...current,
      lastOpenedPath: conflict.path,
    }))

    if (conflict.kind === 'text' && conflict.preferredMode === 'diff') {
      setIsDiffMode(true)
      await mountEditor('diff')
    } else {
      setIsDiffMode(false)
      await mountEditor('plain')
    }

    editor?.focus()
  }

  async function saveAndSyncCurrentNote() {
    clearPendingSave()

    const saveResult = await saveCurrentNote(noteContext)
    trackSaveResult(saveResult)

    if (!shouldSyncAfterSaveResult(saveResult)) {
      return
    }

    await requestSync({ mode: 'full', skipPendingSave: true })
  }

  function scheduleSave() {
    clearPendingSave()

    saveTimeout = window.setTimeout(() => {
      saveTimeout = undefined
      void saveAndSyncCurrentNote().catch(reportError)
    }, 400)
  }

  async function flushPendingSave(options: { force?: boolean } = {}): Promise<FlushPendingSaveResult> {
    const hadPendingSave = clearPendingSave()

    if (!hadPendingSave && options.force !== true) {
      return { status: 'skipped' }
    }

    const saveResult = await saveCurrentNote(noteContext)
    trackSaveResult(saveResult)
    return saveResult
  }

  async function prepareForStorageChange(): Promise<boolean> {
    if (storage() === null) {
      return true
    }

    const saveResult = await flushPendingSave({ force: true })

    if (isSaveBlockedByConflict(saveResult)) {
      return false
    }

    if (hasKnownLocalChangesSinceSync()) {
      await requestSync({ mode: 'full', skipPendingSave: true })
    }

    return true
  }

  async function findAvailableConflictCopyPath(path: string): Promise<string> {
    const currentStorage = storage()

    if (currentStorage === null) {
      throw new Error('Storage is not ready yet.')
    }

    const timestamp = new Date().toISOString()

    for (let attempt = 0; ; attempt += 1) {
      const candidate = createConflictCopyPath(path, timestamp, attempt)

      if ((await currentStorage.readFile(candidate)) === null) {
        return candidate
      }
    }
  }

  async function writeConflictDiskFile(currentStorage: NoteStorage, conflict: NoteConflict): Promise<void> {
    if (conflict.diskFile === null) {
      await currentStorage.deleteEntry(conflict.path)
      return
    }

    if (isRemoteBlobFile(conflict.diskFile)) {
      await writeStoredFile(currentStorage, conflict.path, {
        format: 'binary',
        content: await api.getBlob(conflict.diskFile.contentHash),
        mimeType: conflict.diskFile.mimeType,
      })
      return
    }

    await writeStoredFile(currentStorage, conflict.path, toWriteFileInput(conflict.diskFile))
  }

  async function promoteNextQueuedConflict() {
    const [nextConflict, ...remainingConflicts] = queuedNoteConflicts()
    const currentStorage = storage()

    if (nextConflict === undefined) {
      return
    }

    if (currentStorage !== null) {
      if (nextConflict.kind === 'text') {
        if (nextConflict.loadedSnapshot !== null || nextConflict.draftContent.length > 0) {
          await currentStorage.writeTextFile(nextConflict.path, nextConflict.draftContent)
        } else {
          await currentStorage.deleteEntry(nextConflict.path)
        }
      } else if (nextConflict.localFile !== null) {
        await writeStoredFile(currentStorage, nextConflict.path, toWriteFileInput(nextConflict.localFile))
      } else {
        await currentStorage.deleteEntry(nextConflict.path)
      }
    }

    setQueuedNoteConflictsSignal(remainingConflicts)
    setNoteConflict(nextConflict)
  }

  async function overwriteConflictWithDraft() {
    const currentStorage = storage()
    const conflict = noteConflict()

    if (currentStorage === null || conflict === null) {
      return
    }

    setErrorMessage(null)

    if (conflict.kind === 'text') {
      await currentStorage.writeTextFile(conflict.path, conflict.draftContent)
    } else if (conflict.localFile !== null) {
      await writeStoredFile(currentStorage, conflict.path, toWriteFileInput(conflict.localFile))
    } else {
      await currentStorage.deleteEntry(conflict.path)
    }

    setHasUnsyncedWorkspaceChanges(true)
    setNoteConflict(null)
    await loadNote(noteContext, conflict.path)
    snapshotCurrentOpenNoteForSync()
    await requestSync({ mode: 'full', skipPendingSave: true })

    if (noteConflict() === null) {
      await promoteNextQueuedConflict()
    }
  }

  async function restoreConflictFromDisk() {
    const currentStorage = storage()
    const conflict = noteConflict()

    if (currentStorage === null || conflict === null) {
      return
    }

    setErrorMessage(null)
    setHasUnsyncedWorkspaceChanges(true)

    await writeConflictDiskFile(currentStorage, conflict)
    setNoteConflict(null)
    await loadNote(noteContext, conflict.path)
    snapshotCurrentOpenNoteForSync()
    await promoteNextQueuedConflict()
  }

  async function saveConflictDraftAsCopy() {
    const currentStorage = storage()
    const conflict = noteConflict()

    if (currentStorage === null || conflict === null) {
      return
    }

    setErrorMessage(null)

    const copyPath = await findAvailableConflictCopyPath(conflict.path)

    if (conflict.kind === 'text') {
      await currentStorage.writeTextFile(copyPath, conflict.draftContent)
    } else if (conflict.localFile !== null) {
      await writeStoredFile(currentStorage, copyPath, toWriteFileInput(conflict.localFile))
    }

    await writeConflictDiskFile(currentStorage, conflict)

    setHasUnsyncedWorkspaceChanges(true)
    setNoteConflict(null)
    await refreshWorkspace(conflict.diskFile === null ? copyPath : conflict.path)
    snapshotCurrentOpenNoteForSync()
    await requestSync({ mode: 'full', skipPendingSave: true })

    if (noteConflict() === null) {
      await promoteNextQueuedConflict()
    }
  }

  async function handleOverwriteWithDraft() {
    await overwriteConflictWithDraft()
  }

  async function handleRestoreFromDisk() {
    await restoreConflictFromDisk()
  }

  async function handleSaveDraftAsCopy() {
    await saveConflictDraftAsCopy()
  }

  async function handleOpenConflictDiff() {
    const conflict = noteConflict()

    if (conflict === null || conflict.kind !== 'text') {
      return
    }

    setErrorMessage(null)
    updateNoteConflict((currentConflict) =>
      currentConflict.kind === 'text'
        ? {
            ...currentConflict,
            preferredMode: 'diff',
          }
        : currentConflict,
    )
    await reopenConflictNote(conflict.path)
  }

  async function handleCancelConflictDiff() {
    setIsDiffMode(false)
    await mountEditor('plain')
    editor?.focus()
  }

  async function handleSaveResolvedVersion() {
    await overwriteConflictWithDraft()
  }

  async function handleSaveResolvedAsCopy() {
    await saveConflictDraftAsCopy()
  }

  async function handleSaveSourceVersion() {
    await restoreConflictFromDisk()
  }

  async function handleCreateNote(
    parentPath: string | null,
    name: string,
    submitSource: EntryEditorSubmitSource,
  ): Promise<string | null> {
    try {
      const saveResult = await flushPendingSave()

      if (isSaveBlockedByConflict(saveResult)) {
        return ACTIVE_CONFLICT_MESSAGE
      }

      const message = await createNote(noteContext, parentPath, name)

      snapshotCurrentOpenNoteForSync()

      if (shouldSyncAfterSaveResult(saveResult) || message === null) {
        setHasUnsyncedWorkspaceChanges(true)
        await requestSync({ mode: 'full', skipPendingSave: true })
      }

      if (message === null && submitSource === 'enter') {
        window.requestAnimationFrame(() => {
          editor?.focus()
        })
      }

      return message
    } catch (error) {
      reportError(error)
      return getErrorMessage(error)
    }
  }

  async function handleCreateFolder(parentPath: string | null, name: string): Promise<string | null> {
    try {
      const saveResult = await flushPendingSave()

      if (isSaveBlockedByConflict(saveResult)) {
        return ACTIVE_CONFLICT_MESSAGE
      }

      const message = await createFolder(noteContext, parentPath, name)

      snapshotCurrentOpenNoteForSync()

      if (shouldSyncAfterSaveResult(saveResult) || message === null) {
        setHasUnsyncedWorkspaceChanges(true)
        await requestSync({ mode: 'full', skipPendingSave: true })
      }

      return message
    } catch (error) {
      reportError(error)
      return getErrorMessage(error)
    }
  }

  function handleDeleteEntry(path: string, kind: ListedEntry['kind']) {
    void (async () => {
      const saveResult = await flushPendingSave()

      if (isSaveBlockedByConflict(saveResult)) {
        return
      }

      const didDelete = await deleteEntry(noteContext, { path, kind })

      snapshotCurrentOpenNoteForSync()

      if (shouldSyncAfterSaveResult(saveResult) || didDelete) {
        setHasUnsyncedWorkspaceChanges(true)
        await requestSync({ mode: 'full', skipPendingSave: true })
      }
    })().catch(reportError)
  }

  async function handleRenameEntry(path: string, kind: ListedEntry['kind'], name: string): Promise<string | null> {
    try {
      const saveResult = await flushPendingSave()

      if (isSaveBlockedByConflict(saveResult)) {
        return ACTIVE_CONFLICT_MESSAGE
      }

      const message = await renameEntry(noteContext, { path, kind }, name)

      snapshotCurrentOpenNoteForSync()

      if (shouldSyncAfterSaveResult(saveResult) || message === null) {
        setHasUnsyncedWorkspaceChanges(true)
        await requestSync({ mode: 'full', skipPendingSave: true })
      }

      return message
    } catch (error) {
      reportError(error)
      return getErrorMessage(error)
    }
  }

  async function handleMoveEntry(entry: ListedEntry, parentPath: string | null): Promise<boolean> {
    try {
      const saveResult = await flushPendingSave()

      if (isSaveBlockedByConflict(saveResult)) {
        setErrorMessage(ACTIVE_CONFLICT_MESSAGE)
        return false
      }

      const result = await moveEntry(noteContext, entry, parentPath)

      if (result.message !== null) {
        setErrorMessage(result.message)
      }

      snapshotCurrentOpenNoteForSync()

      if (shouldSyncAfterSaveResult(saveResult) || result.didMove) {
        setHasUnsyncedWorkspaceChanges(true)
        await requestSync({ mode: 'full', skipPendingSave: true })
      }

      return result.didMove
    } catch (error) {
      reportError(error)
      return false
    }
  }

  function handleAttachFolder() {
    void (async () => {
      if (!(await prepareForStorageChange())) {
        return
      }

      const currentStorage = storage()
      const sourceEntries = currentStorage?.key === 'opfs' ? await currentStorage.listEntries() : []
      const handle = await pickFolderHandle(storageContext)
      let didTransfer = false

      if (handle === null) {
        return
      }

      const nextStorage = createDirectoryStorage(handle)
      const targetEntries = await nextStorage.listEntries()

      if (currentStorage?.key === 'opfs' && sourceEntries.length > 0 && window.confirm(getOpfsTransferPrompt(handle.name))) {
        const conflicts = await getStorageTransferConflicts(currentStorage, nextStorage, sourceEntries, targetEntries)

        if (conflicts.length > 0) {
          throw new Error(getStorageTransferConflictMessage(handle.name, conflicts[0]))
        }

        await copyStorageEntries(currentStorage, nextStorage, sourceEntries)
        didTransfer = true
      }

      await activateDirectoryHandle(storageContext, handle)

      if (currentStorage?.key === 'opfs' && !didTransfer && targetEntries.length === 0) {
        setSyncStateSignal(DEFAULT_SYNC_STATE)
        await persistSyncState(requireUserId(), DEFAULT_SYNC_STATE)
      }

      await requestSync({ mode: 'full' })
    })().catch(reportError)
  }

  function handleReconnectFolder() {
    void (async () => {
      if (!(await prepareForStorageChange())) {
        return
      }

      await reconnectFolder(storageContext)
      await requestSync({ mode: 'full' })
    })().catch(reportError)
  }

  function handleSwitchToOpfs() {
    void (async () => {
      if (!(await prepareForStorageChange())) {
        return
      }

      const currentStorage = storage()

      if (currentStorage?.key === 'directory') {
        await replaceStorageEntries(currentStorage, createOpfsStorage())
      }

      await switchToOpfs(storageContext)
      await requestSync({ mode: 'full' })
    })().catch(reportError)
  }

  function handleSync() {
    void requestSync({ mode: 'full' }).catch(reportError)
  }

  if (typeof document !== 'undefined') {
    const handleDocumentHotkeys = createMultiHotkeyHandler(
      {
        'Mod+Shift+S': () => {
          // Let the keydown finish before kicking off sync so browser-level Shift+Save handling does not swallow it.
          window.setTimeout(() => {
            handleSync()
          }, 0)
        },
        'Mod+S': () => {
          if (isDiffMode()) {
            void handleSaveResolvedVersion().catch(reportError)
            return
          }

          void saveAndSyncCurrentNote().catch(reportError)
        },
      },
      {
        preventDefault: true,
        stopPropagation: true,
      },
    )

    document.addEventListener('keydown', handleDocumentHotkeys, true)

    onCleanup(() => {
      document.removeEventListener('keydown', handleDocumentHotkeys, true)
    })
  }

  function triggerAutoSync() {
    if (storage() === null || noteConflict() !== null || document.visibilityState !== 'visible') {
      return
    }

    const now = Date.now()

    if (now - lastAutoSyncAt < AUTO_SYNC_COOLDOWN_MS) {
      return
    }

    lastAutoSyncAt = now
    void requestSync({ mode: 'precheck-if-clean' }).catch(reportError)
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      triggerAutoSync()
    }
  }

  function handleWindowFocus() {
    triggerAutoSync()
  }

  function handleWindowOnline() {
    triggerAutoSync()
  }

  function handleResizeStart(event: MouseEvent) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth()

    function onMouseMove(event: MouseEvent) {
      const width = Math.max(150, Math.min(startWidth + event.clientX - startX, 600))
      setSidebarWidth(width)
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  function handleOpenNote(path: string) {
    void (async () => {
      const conflict = noteConflict()

      if (conflict !== null) {
        if (path === conflict.path) {
          await reopenConflictNote(path)
          return
        }

        if (currentPath() === conflict.path) {
          clearPendingSave()
          setIsDiffMode(false)
          await loadNote(noteContext, path)
          snapshotCurrentOpenNoteForSync()
          await mountEditor('plain')
          editor?.focus()
          return
        }
      }

      const saveResult = await flushPendingSave()

      if (isSaveBlockedByConflict(saveResult)) {
        return
      }

      await loadNote(noteContext, path)
      snapshotCurrentOpenNoteForSync()

      if (shouldSyncAfterSaveResult(saveResult)) {
        await requestSync({ mode: 'full', skipPendingSave: true })
      }
    })().catch(reportError)
  }

  onMount(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('online', handleWindowOnline)
    autoSyncInterval = window.setInterval(() => {
      triggerAutoSync()
    }, AUTO_SYNC_INTERVAL_MS)

    void mountEditor('plain').catch(reportError)
    void api.getSession()
      .then(async (session) => {
        setUserId(session.userId)
        await bootstrapWorkspace(storageContext)

        if (storage() !== null) {
          await requestSync({ mode: 'full' })
        }
      })
      .catch(reportError)
      .finally(() => {
        setHasBootstrapped(true)
      })
  })

  onCleanup(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('focus', handleWindowFocus)
    window.removeEventListener('online', handleWindowOnline)

    if (autoSyncInterval !== undefined) {
      window.clearInterval(autoSyncInterval)
    }

    clearPendingSave()
    editor?.dispose()
    activeEditorPath = null
    setEditorLanguageId(null)
  })

  return (
    <div class="app">
      <main class="workspace" style={{ 'grid-template-columns': `${sidebarWidth()}px 0px 1fr` } as JSX.CSSProperties}>
        <Show when={settings().backend} keyed>
          <NotesSidebar
            conflict={conflictSummary()}
            conflictPaths={conflictPaths()}
            currentPath={currentPath()}
            emptyMessage={emptyMessage()}
            fileCount={fileCount()}
            isReady={storage() !== null}
            nodes={tree()}
            persistedOpenDirectoryPaths={settings().openDirectoryPaths[settings().backend]}
            unsavedPath={unsavedPath()}
            onAcceptTheirs={() => {
              void handleRestoreFromDisk().catch(reportError)
            }}
            onCreateFolder={handleCreateFolder}
            onCreateNote={handleCreateNote}
            onDeleteEntry={handleDeleteEntry}
            onOpen={handleOpenNote}
            onOpenConflict={handleOpenNote}
            onMoveEntry={handleMoveEntry}
            onPersistedOpenDirectoryPathsChange={(nextOpenDirectoryPaths) => {
              void updateSettings((current) => {
                const persistedOpenDirectoryPaths = current.openDirectoryPaths[current.backend]

                if (arePathArraysEqual(persistedOpenDirectoryPaths, nextOpenDirectoryPaths)) {
                  return current
                }

                return {
                  ...current,
                  openDirectoryPaths: {
                    ...current.openDirectoryPaths,
                    [current.backend]: nextOpenDirectoryPaths,
                  },
                }
              }).catch(reportError)
            }}
            onRenameEntry={handleRenameEntry}
            onResolveInDiff={() => {
              void handleOpenConflictDiff().catch(reportError)
            }}
            onSaveMine={() => {
              void handleOverwriteWithDraft().catch(reportError)
            }}
            onSaveMineSeparately={() => {
              void handleSaveDraftAsCopy().catch(reportError)
            }}
          />
        </Show>
        <div class="resize-handle" onMouseDown={handleResizeStart} />
        <EditorPane
          currentPath={currentPath()}
          currentFile={loadedFileSnapshot()}
          fileViewKind={currentFileViewKind()}
          isDiffMode={isDiffMode()}
          reconnectableDirectoryName={reconnectableDirectoryName()}
          onAttachFolder={handleAttachFolder}
          onCancelConflictDiff={() => {
            void handleCancelConflictDiff().catch(reportError)
          }}
          onEditorMount={(element) => {
            editorElement = element
          }}
          onReconnectFolder={handleReconnectFolder}
          onSaveSourceVersion={() => {
            void handleSaveSourceVersion().catch(reportError)
          }}
          onSaveResolvedAsCopy={() => {
            void handleSaveResolvedAsCopy().catch(reportError)
          }}
          onSaveResolvedVersion={() => {
            void handleSaveResolvedVersion().catch(reportError)
          }}
          saveSourceVersionLabel={diffSourceVersionLabel()}
          onSwitchToOpfs={handleSwitchToOpfs}
        />
      </main>
      <StatusBar
        conflict={conflictSummary()}
        editorLanguage={editorLanguageId()}
        editorPath={currentPath() ?? 'untitled.md'}
        errorMessage={errorMessage()}
        canReconnectFolder={reconnectableDirectoryName() !== null}
        canSync={storage() !== null}
        isOpfsActive={isOpfsActive()}
        isSyncing={isSyncing()}
        lastSyncedAt={syncState().lastSyncedAt}
        reconnectLabel={reconnectableDirectoryName()}
        storageLabel={storageLabel()}
        onAcceptTheirs={() => {
          void handleRestoreFromDisk().catch(reportError)
        }}
        onAttachFolder={handleAttachFolder}
        onReconnectFolder={handleReconnectFolder}
        onResolveInDiff={() => {
          void handleOpenConflictDiff().catch(reportError)
        }}
        onSaveMine={() => {
          void handleOverwriteWithDraft().catch(reportError)
        }}
        onSaveMineSeparately={() => {
          void handleSaveDraftAsCopy().catch(reportError)
        }}
        onSync={handleSync}
        onSwitchToOpfs={handleSwitchToOpfs}
      />
    </div>
  )
}

export default App
