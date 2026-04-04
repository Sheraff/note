import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createApiClient } from './api.ts'
import { Codicon } from './Codicon.tsx'
import type { MonacoController } from './editor/monaco.ts'
import { FileTree } from './FileTree.tsx'
import { ensureMarkdownExtension, getParentPath, normalizeNotePath } from './notes/paths.ts'
import { syncWithServer } from './notes/sync.ts'
import { buildTree } from './notes/tree.ts'
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type SyncState,
} from './schemas.ts'
import {
  createDirectoryStorage,
  hasDirectoryPermission,
  pickDirectoryHandle,
} from './storage/file-system-access.ts'
import {
  getAppSettings,
  getDirectoryHandle,
  getSyncState,
  setAppSettings,
  setDirectoryHandle,
  setSyncState,
} from './storage/metadata.ts'
import { createOpfsStorage } from './storage/opfs.ts'
import { isDirectoryPickerSupported, type ListedEntry, type NoteStorage } from './storage/types.ts'

const api = createApiClient()

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
  const [settings, setSettingsSignal] = createSignal<AppSettings>(DEFAULT_APP_SETTINGS)
  const [entries, setEntries] = createSignal<ListedEntry[]>([])
  const [currentPath, setCurrentPath] = createSignal<string | null>(null)
  const [draftContent, setDraftContent] = createSignal('')
  const [statusMessage, setStatusMessage] = createSignal('Loading workspace...')
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [syncState, setSyncStateSignal] = createSignal<SyncState>({ files: [], lastSyncedAt: null })
  const [isSaving, setIsSaving] = createSignal(false)
  const [isSyncing, setIsSyncing] = createSignal(false)

  const tree = createMemo(() => buildTree(entries()))
  const fileEntries = createMemo(() => entries().filter((entry) => entry.kind === 'file'))

  function clearMessages() {
    setErrorMessage(null)
  }

  async function persistSettings(next: AppSettings) {
    setSettingsSignal(next)
    await setAppSettings(next)
  }

  async function loadNote(path: string | null): Promise<void> {
    const currentStorage = storage()

    if (currentStorage === null || path === null) {
      setCurrentPath(null)
      setDraftContent('')
      editor?.setValue('')
      return
    }

    const file = await currentStorage.readTextFile(path)

    if (file === null) {
      await refreshWorkspace(null)
      return
    }

    setCurrentPath(file.path)
    setDraftContent(file.content)
    editor?.setValue(file.content)
    await persistSettings({
      ...settings(),
      lastOpenedPath: file.path,
    })
  }

  async function refreshWorkspace(preferredPath: string | null): Promise<void> {
    const currentStorage = storage()

    if (currentStorage === null) {
      return
    }

    const nextEntries = await currentStorage.listEntries()
    setEntries(nextEntries)

    const filePaths = nextEntries.filter((entry) => entry.kind === 'file').map((entry) => entry.path)
    const activePath = currentPath()
    const desiredPath =
      (preferredPath !== null && filePaths.includes(preferredPath) && preferredPath) ||
      (activePath !== null && filePaths.includes(activePath) && activePath) ||
      filePaths[0] ||
      null

    await loadNote(desiredPath)
  }

  async function saveCurrentNote(): Promise<void> {
    const currentStorage = storage()
    const path = currentPath()

    if (currentStorage === null || path === null) {
      return
    }

    setIsSaving(true)

    try {
      await currentStorage.writeTextFile(path, draftContent())
      setStatusMessage(`Saved ${path}`)
    } finally {
      setIsSaving(false)
    }
  }

  function scheduleSave() {
    if (saveTimeout !== undefined) {
      window.clearTimeout(saveTimeout)
    }

    saveTimeout = window.setTimeout(() => {
      void saveCurrentNote().catch((error: unknown) => {
        setErrorMessage(getErrorMessage(error))
      })
    }, 400)
  }

  async function flushPendingSave(): Promise<void> {
    if (saveTimeout !== undefined) {
      window.clearTimeout(saveTimeout)
      saveTimeout = undefined
    }

    await saveCurrentNote()
  }

  async function switchStorage(nextStorage: NoteStorage, nextSettings: AppSettings, status: string) {
    clearMessages()
    setStorage(nextStorage)
    await persistSettings(nextSettings)
    setStatusMessage(status)
    await refreshWorkspace(nextSettings.lastOpenedPath)
    editor?.focus()
  }

  async function bootstrapWorkspace(): Promise<void> {
    const loadedSettings = await getAppSettings()
    const loadedSyncState = await getSyncState()
    setSettingsSignal(loadedSettings)
    setSyncStateSignal(loadedSyncState)

    if (loadedSettings.backend === 'directory') {
      const handle = await getDirectoryHandle()

      if (handle !== null && (await hasDirectoryPermission(handle))) {
        await switchStorage(
          createDirectoryStorage(handle),
          loadedSettings,
          `Using folder ${handle.name}`,
        )
        return
      }

      await switchStorage(
        createOpfsStorage(),
        {
          ...loadedSettings,
          backend: 'opfs',
        },
        'Stored folder access is no longer available. Switched back to OPFS.',
      )
      return
    }

    await switchStorage(createOpfsStorage(), loadedSettings, 'Using browser-private storage (OPFS).')
  }

  async function createNote() {
    const currentStorage = storage()

    if (currentStorage === null) {
      return
    }

    const defaultDirectory = getParentPath(currentPath() ?? '')
    const defaultPath = defaultDirectory === null ? 'untitled.md' : `${defaultDirectory}/untitled.md`
    const value = window.prompt('New note path', defaultPath)

    if (value === null) {
      return
    }

    const path = ensureMarkdownExtension(value)

    if (path.length === 0) {
      setErrorMessage('Enter a valid note path.')
      return
    }

    clearMessages()
    await currentStorage.writeTextFile(path, '# Untitled\n')
    setStatusMessage(`Created ${path}`)
    await refreshWorkspace(path)
  }

  async function createFolder() {
    const currentStorage = storage()

    if (currentStorage === null) {
      return
    }

    const defaultDirectory = getParentPath(currentPath() ?? '') ?? 'notes'
    const value = window.prompt('New folder path', defaultDirectory)

    if (value === null) {
      return
    }

    const path = normalizeNotePath(value)

    if (path.length === 0) {
      setErrorMessage('Enter a valid folder path.')
      return
    }

    clearMessages()
    await currentStorage.createDirectory(path)
    setStatusMessage(`Created folder ${path}`)
    await refreshWorkspace(currentPath())
  }

  async function deleteCurrentNote() {
    const currentStorage = storage()
    const path = currentPath()

    if (currentStorage === null || path === null) {
      return
    }

    if (!window.confirm(`Delete ${path}?`)) {
      return
    }

    clearMessages()
    await currentStorage.deleteEntry(path)
    setStatusMessage(`Deleted ${path}`)
    await refreshWorkspace(null)
  }

  async function attachFolder() {
    if (!isDirectoryPickerSupported()) {
      setErrorMessage('This browser does not support the File System Access API.')
      return
    }

    clearMessages()

    try {
      const handle = await pickDirectoryHandle()

      if (!(await hasDirectoryPermission(handle))) {
        throw new Error('Folder access was not granted')
      }

      await setDirectoryHandle(handle)
      await switchStorage(
        createDirectoryStorage(handle),
        {
          ...settings(),
          backend: 'directory',
        },
        `Using folder ${handle.name}`,
      )
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function useOpfs() {
    clearMessages()
    await switchStorage(
      createOpfsStorage(),
      {
        ...settings(),
        backend: 'opfs',
      },
      'Using browser-private storage (OPFS).',
    )
  }

  async function syncNow() {
    const currentStorage = storage()

    if (currentStorage === null) {
      return
    }

    clearMessages()
    setIsSyncing(true)

    try {
      await flushPendingSave()
      const nextSyncState = await syncWithServer({
        api,
        previousState: syncState(),
        storage: currentStorage,
      })
      setSyncStateSignal(nextSyncState)
      await setSyncState(nextSyncState)
      await refreshWorkspace(currentPath())
      setStatusMessage(`Synced ${nextSyncState.files.length} records.`)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setIsSyncing(false)
    }
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
        void flushPendingSave().catch((error: unknown) => {
          setErrorMessage(getErrorMessage(error))
        })
      },
    })
  }

  onMount(() => {
    void mountEditor().catch((error: unknown) => {
      setErrorMessage(getErrorMessage(error))
    })

    void bootstrapWorkspace().catch((error: unknown) => {
      setErrorMessage(getErrorMessage(error))
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
    <div class="app-shell">
      <header class="topbar">
        <div>
          <h1>Note</h1>
          <p>{statusMessage()}</p>
        </div>
        <div class="topbar-actions">
          <span class="pill">
            <span>
              <Codicon name="database" />
              <span>Storage: {storage()?.label ?? 'Loading...'}</span>
            </span>
          </span>
          <span class="pill">
            <span>
              <Codicon name="history" />
              <span>
                {syncState().lastSyncedAt === null ? 'Not synced yet' : `Last sync ${syncState().lastSyncedAt}`}
              </span>
            </span>
          </span>
          <button type="button" onClick={() => void createNote()}>
            <Codicon name="new-file" />
            <span>New note</span>
          </button>
          <button type="button" onClick={() => void createFolder()}>
            <Codicon name="new-folder" />
            <span>New folder</span>
          </button>
          <button type="button" onClick={() => void deleteCurrentNote()} disabled={currentPath() === null}>
            <Codicon name="trash" />
            <span>Delete note</span>
          </button>
          <button type="button" onClick={() => void attachFolder()}>
            <Codicon name="folder-library" />
            <span>Attach folder</span>
          </button>
          <button type="button" onClick={() => void useOpfs()} disabled={settings().backend === 'opfs'}>
            <Codicon name="database" />
            <span>Use OPFS</span>
          </button>
          <button type="button" onClick={() => void syncNow()} disabled={isSyncing()} aria-busy={isSyncing()}>
            <Codicon name={isSyncing() ? 'loading' : 'sync'} />
            <span>{isSyncing() ? 'Syncing...' : 'Sync'}</span>
          </button>
        </div>
      </header>
      <Show when={errorMessage() !== null}>
        <div class="error-banner">{errorMessage()}</div>
      </Show>
      <main class="workspace">
        <aside class="sidebar">
          <div class="sidebar-header">
            <h2>Notes</h2>
            <span>{fileEntries().length}</span>
          </div>
          <Show
            when={tree().length > 0}
            fallback={<p class="empty-state">Create a note to start writing.</p>}
          >
            <FileTree
              currentPath={currentPath()}
              nodes={tree()}
              onOpen={(path) => {
                void flushPendingSave()
                  .then(() => loadNote(path))
                  .catch((error: unknown) => {
                    setErrorMessage(getErrorMessage(error))
                  })
              }}
            />
          </Show>
        </aside>
        <section class="editor-pane">
          <div class="editor-header">
            <div>
              <h2>{currentPath() ?? 'No note selected'}</h2>
              <p>{isSaving() ? 'Saving...' : 'Autosave enabled. Press Ctrl/Cmd+S to save now.'}</p>
            </div>
          </div>
          <div class="editor-stage">
            <div class="editor-surface" ref={editorElement} />
            <Show when={currentPath() === null}>
              <div class="editor-empty">Select a note from the sidebar or create one.</div>
            </Show>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
