import { createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { EditorPane } from './app/EditorPane.tsx'
import { NotesSidebar } from './app/NotesSidebar.tsx'
import { StatusBar } from './app/StatusBar.tsx'
import {
  createFolder,
  createNote,
  deleteEntry,
  loadNote,
  renameEntry,
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

  const [sidebarWidth, setSidebarWidth] = createSignal(300)

  const [storage, setStorage] = createSignal<NoteStorage | null>(null)
  const [settings, setSettings] = createSignal<AppSettings>(DEFAULT_APP_SETTINGS)
  const [entries, setEntries] = createSignal<ListedEntry[]>([])
  const [currentPath, setCurrentPath] = createSignal<string | null>(null)
  const [draftContent, setDraftContent] = createSignal('')
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [syncState, setSyncStateSignal] = createSignal<SyncState>({ files: [], lastSyncedAt: null })
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
      initialValue: draftContent(),
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

  async function handleRenameEntry(path: string, kind: ListedEntry['kind'], name: string): Promise<string | null> {
    try {
      await flushPendingSave()
      return await renameEntry(noteContext, { path, kind }, name)
    } catch (error) {
      reportError(error)
      return getErrorMessage(error)
    }
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
    void flushPendingSave().then(() => loadNote(noteContext, path)).catch(reportError)
  }

  onMount(() => {
    void mountEditor().catch(reportError)
    void bootstrapWorkspace(storageContext).catch(reportError)
  })

  onCleanup(() => {
    if (saveTimeout !== undefined) {
      window.clearTimeout(saveTimeout)
    }

    editor?.dispose()
  })

  return (
    <div class="app">
      <main class="workspace" style={{ 'grid-template-columns': `${sidebarWidth()}px 0px 1fr` } as JSX.CSSProperties}>
        <NotesSidebar
          currentPath={currentPath()}
          fileCount={fileCount()}
          nodes={tree()}
          onCreateFolder={handleCreateFolder}
          onCreateNote={handleCreateNote}
          onDeleteEntry={handleDeleteEntry}
          onOpen={handleOpenNote}
          onRenameEntry={handleRenameEntry}
        />
        <div class="resize-handle" onMouseDown={handleResizeStart} />
        <EditorPane
          currentPath={currentPath()}
          onEditorMount={(element) => {
            editorElement = element
          }}
        />
      </main>
      <StatusBar
        errorMessage={errorMessage()}
        isOpfsActive={isOpfsActive()}
        isSyncing={isSyncing()}
        lastSyncedAt={syncState().lastSyncedAt}
        storageLabel={storageLabel()}
        onAttachFolder={handleAttachFolder}
        onSync={handleSync}
        onSwitchToOpfs={handleSwitchToOpfs}
      />
    </div>
  )
}

export default App
