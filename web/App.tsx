import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { AppHeader } from './app/AppHeader.tsx'
import { EditorPane } from './app/EditorPane.tsx'
import { NotesSidebar } from './app/NotesSidebar.tsx'
import {
  createFolder,
  createNote,
  deleteEntry,
  loadNote,
  refreshWorkspace,
  saveCurrentNote,
  type NoteContext,
} from './app/notes.ts'
import { attachFolder, bootstrapWorkspace, switchToOpfs, type StorageContext } from './app/storage.ts'
import { syncNow, type SyncContext } from './app/sync.ts'
import type { MonacoController } from './editor/monaco.ts'
import { buildTree } from './notes/tree.ts'
import { DEFAULT_APP_SETTINGS, type AppSettings, type SyncState } from './schemas.ts'
import { setAppSettings } from './storage/metadata.ts'
import type { ListedEntry, NoteStorage } from './storage/types.ts'
import './App.css'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}

function App() {
  let editorElement: HTMLDivElement | undefined
  let editor: MonacoController | undefined
  let saveTimeout: number | undefined

  const [storage, setStorage] = createSignal<NoteStorage | null>(null)
  const [settings, setSettings] = createSignal<AppSettings>(DEFAULT_APP_SETTINGS)
  const [entries, setEntries] = createSignal<ListedEntry[]>([])
  const [currentPath, setCurrentPath] = createSignal<string | null>(null)
  const [draftContent, setDraftContent] = createSignal('')
  const [statusMessage, setStatusMessage] = createSignal('Loading workspace...')
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [syncState, setSyncStateSignal] = createSignal<SyncState>({ files: [], lastSyncedAt: null })
  const [isSaving, setIsSaving] = createSignal(false)
  const [isSyncing, setIsSyncing] = createSignal(false)

  const tree = createMemo(() => buildTree(entries()))
  const fileCount = createMemo(() => entries().filter((entry) => entry.kind === 'file').length)
  const storageLabel = createMemo(() => storage()?.label ?? 'Loading...')
  const isOpfsActive = createMemo(() => settings().backend === 'opfs')

  function reportError(error: unknown) {
    setErrorMessage(getErrorMessage(error))
  }

  async function saveSettings(nextSettings: AppSettings) {
    setSettings(nextSettings)
    await setAppSettings(nextSettings)
  }

  const noteContext: NoteContext = {
    storage,
    entries,
    currentPath,
    setCurrentPath,
    draftContent,
    setDraftContent,
    settings,
    saveSettings,
    setEntries,
    setStatusMessage,
    setIsSaving,
    setErrorMessage,
    setEditorValue(value) {
      editor?.setValue(value)
    },
  }

  const storageContext: StorageContext = {
    settings,
    setSettings,
    saveSettings,
    setStorage,
    setStatusMessage,
    setSyncState: setSyncStateSignal,
    setErrorMessage,
    refreshWorkspace(preferredPath) {
      return refreshWorkspace(noteContext, preferredPath)
    },
    focusEditor() {
      editor?.focus()
    },
  }

  const syncContext: SyncContext = {
    storage,
    syncState,
    currentPath,
    setSyncState: setSyncStateSignal,
    setStatusMessage,
    setIsSyncing,
    setErrorMessage,
    flushPendingSave,
    refreshWorkspace(preferredPath) {
      return refreshWorkspace(noteContext, preferredPath)
    },
  }

  function scheduleSave() {
    if (saveTimeout !== undefined) {
      window.clearTimeout(saveTimeout)
    }

    saveTimeout = window.setTimeout(() => {
      void saveCurrentNote(noteContext).catch(reportError)
    }, 400)
  }

  async function flushPendingSave() {
    if (saveTimeout !== undefined) {
      window.clearTimeout(saveTimeout)
      saveTimeout = undefined
    }

    await saveCurrentNote(noteContext)
  }

  async function mountEditor() {
    if (editor !== undefined || editorElement === undefined) {
      return
    }

    const monaco = await import('./editor/monaco.ts')

    editor = monaco.createMonacoEditor(editorElement, {
      initialValue: '',
      onChange(value) {
        setDraftContent(value)
        scheduleSave()
      },
      onSave() {
        void flushPendingSave().catch(reportError)
      },
    })
  }

  async function handleCreateNote(parentPath: string | null, name: string): Promise<string | null> {
    try {
      await flushPendingSave()
      return await createNote(noteContext, parentPath, name)
    } catch (error) {
      reportError(error)
      return getErrorMessage(error)
    }
  }

  async function handleCreateFolder(parentPath: string | null, name: string): Promise<string | null> {
    try {
      await flushPendingSave()
      return await createFolder(noteContext, parentPath, name)
    } catch (error) {
      reportError(error)
      return getErrorMessage(error)
    }
  }

  function handleDeleteEntry(path: string, kind: ListedEntry['kind']) {
    void flushPendingSave().then(() => deleteEntry(noteContext, { path, kind })).catch(reportError)
  }

  function handleAttachFolder() {
    void attachFolder(storageContext).catch(reportError)
  }

  function handleSwitchToOpfs() {
    void switchToOpfs(storageContext).catch(reportError)
  }

  function handleSync() {
    void syncNow(syncContext).catch(reportError)
  }

  function handleOpenNote(path: string) {
    void flushPendingSave().then(() => loadNote(noteContext, path)).catch(reportError)
  }

  onMount(() => {
    void mountEditor().catch(reportError)
    void bootstrapWorkspace(storageContext).catch((error) => {
      reportError(error)
      setStatusMessage('Unable to load workspace.')
    })
  })

  onCleanup(() => {
    if (saveTimeout !== undefined) {
      window.clearTimeout(saveTimeout)
    }

    editor?.dispose()
  })

  return (
    <div class="app">
      <AppHeader
        isOpfsActive={isOpfsActive()}
        isSyncing={isSyncing()}
        lastSyncedAt={syncState().lastSyncedAt}
        statusMessage={statusMessage()}
        storageLabel={storageLabel()}
        onAttachFolder={handleAttachFolder}
        onSync={handleSync}
        onSwitchToOpfs={handleSwitchToOpfs}
      />
      <Show when={errorMessage() !== null}>
        <div class="error-banner">{errorMessage()}</div>
      </Show>
      <main class="workspace">
        <NotesSidebar
          currentPath={currentPath()}
          fileCount={fileCount()}
          nodes={tree()}
          onCreateFolder={handleCreateFolder}
          onCreateNote={handleCreateNote}
          onDeleteEntry={handleDeleteEntry}
          onOpen={handleOpenNote}
        />
        <EditorPane
          currentPath={currentPath()}
          isSaving={isSaving()}
          onEditorMount={(element) => {
            editorElement = element
          }}
        />
      </main>
    </div>
  )
}

export default App
