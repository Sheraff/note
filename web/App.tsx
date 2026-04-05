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
import { attachFolder, bootstrapWorkspace, reconnectFolder, switchToOpfs, type StorageContext } from './app/storage.ts'
import { createSyncRequester, syncNow, type SyncContext } from './app/sync.ts'
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

  const [hasBootstrapped, setHasBootstrapped] = createSignal(false)
  const [storage, setStorage] = createSignal<NoteStorage | null>(null)
  const [reconnectableDirectoryName, setReconnectableDirectoryName] = createSignal<string | null>(null)
  const [settings, setSettings] = createSignal<AppSettings>(DEFAULT_APP_SETTINGS)
  const [entries, setEntries] = createSignal<ListedEntry[]>([])
  const [currentPath, setCurrentPath] = createSignal<string | null>(null)
  const [draftContent, setDraftContent] = createSignal('')
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [syncState, setSyncStateSignal] = createSignal<SyncState>({ files: [], lastSyncedAt: null })
  const [isSyncing, setIsSyncing] = createSignal(false)

  const tree = createMemo(() => buildTree(entries()))
  const fileCount = createMemo(() => entries().filter((entry) => entry.kind === 'file').length)
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
    setReconnectableDirectoryName,
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

  const requestSync = createSyncRequester({
    onError: reportError,
    runSync(options) {
      return syncNow(syncContext, options)
    },
  })

  function clearPendingSave() {
    if (saveTimeout === undefined) {
      return false
    }

    window.clearTimeout(saveTimeout)
    saveTimeout = undefined
    return true
  }

  async function saveAndSyncCurrentNote() {
    clearPendingSave()
    await saveCurrentNote(noteContext)
    await requestSync({ skipPendingSave: true })
  }

  function scheduleSave() {
    clearPendingSave()

    saveTimeout = window.setTimeout(() => {
      saveTimeout = undefined
      void saveAndSyncCurrentNote().catch(reportError)
    }, 400)
  }

  async function flushPendingSave(options: { force?: boolean } = {}): Promise<boolean> {
    const hadPendingSave = clearPendingSave()

    if (!hadPendingSave && options.force !== true) {
      return false
    }

    await saveCurrentNote(noteContext)
    return true
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
        void saveAndSyncCurrentNote().catch(reportError)
      },
    })
  }

  async function handleCreateNote(parentPath: string | null, name: string): Promise<string | null> {
    try {
      const didSave = await flushPendingSave()
      const message = await createNote(noteContext, parentPath, name)

      if (didSave || message === null) {
        await requestSync({ skipPendingSave: true })
      }

      return message
    } catch (error) {
      reportError(error)
      return getErrorMessage(error)
    }
  }

  async function handleCreateFolder(parentPath: string | null, name: string): Promise<string | null> {
    try {
      const didSave = await flushPendingSave()
      const message = await createFolder(noteContext, parentPath, name)

      if (didSave || message === null) {
        await requestSync({ skipPendingSave: true })
      }

      return message
    } catch (error) {
      reportError(error)
      return getErrorMessage(error)
    }
  }

  function handleDeleteEntry(path: string, kind: ListedEntry['kind']) {
    void (async () => {
      const didSave = await flushPendingSave()
      const didDelete = await deleteEntry(noteContext, { path, kind })

      if (didSave || didDelete) {
        await requestSync({ skipPendingSave: true })
      }
    })().catch(reportError)
  }

  async function handleRenameEntry(path: string, kind: ListedEntry['kind'], name: string): Promise<string | null> {
    try {
      const didSave = await flushPendingSave()
      const message = await renameEntry(noteContext, { path, kind }, name)

      if (didSave || message === null) {
        await requestSync({ skipPendingSave: true })
      }

      return message
    } catch (error) {
      reportError(error)
      return getErrorMessage(error)
    }
  }

  function handleAttachFolder() {
    void attachFolder(storageContext).catch(reportError)
  }

  function handleReconnectFolder() {
    void reconnectFolder(storageContext).catch(reportError)
  }

  function handleSwitchToOpfs() {
    void switchToOpfs(storageContext).catch(reportError)
  }

  function handleSync() {
    void requestSync().catch(reportError)
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
      const didSave = await flushPendingSave()
      await loadNote(noteContext, path)

      if (didSave) {
        await requestSync({ skipPendingSave: true })
      }
    })().catch(reportError)
  }

  onMount(() => {
    void mountEditor().catch(reportError)
    void bootstrapWorkspace(storageContext)
      .catch(reportError)
      .finally(() => {
        setHasBootstrapped(true)
      })
  })

  onCleanup(() => {
    clearPendingSave()

    editor?.dispose()
  })

  return (
    <div class="app">
      <main class="workspace" style={{ 'grid-template-columns': `${sidebarWidth()}px 0px 1fr` } as JSX.CSSProperties}>
        <NotesSidebar
          currentPath={currentPath()}
          emptyMessage={emptyMessage()}
          fileCount={fileCount()}
          isReady={storage() !== null}
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
          reconnectableDirectoryName={reconnectableDirectoryName()}
          onAttachFolder={handleAttachFolder}
          onEditorMount={(element) => {
            editorElement = element
          }}
          onReconnectFolder={handleReconnectFolder}
          onSwitchToOpfs={handleSwitchToOpfs}
        />
      </main>
      <StatusBar
        errorMessage={errorMessage()}
        canReconnectFolder={reconnectableDirectoryName() !== null}
        canSync={storage() !== null}
        isOpfsActive={isOpfsActive()}
        isSyncing={isSyncing()}
        lastSyncedAt={syncState().lastSyncedAt}
        reconnectLabel={reconnectableDirectoryName()}
        storageLabel={storageLabel()}
        onAttachFolder={handleAttachFolder}
        onReconnectFolder={handleReconnectFolder}
        onSync={handleSync}
        onSwitchToOpfs={handleSwitchToOpfs}
      />
    </div>
  )
}

export default App
