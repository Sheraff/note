import { Show, createSignal } from 'solid-js'
import type { TreeNode } from '../notes/tree.ts'
import { Codicon } from './Codicon.tsx'
import { type ConflictActionLabels } from './ConflictActions.tsx'
import { FileTree, type PendingCreation, type PendingRename } from './FileTree.tsx'
import './NotesSidebar.css'

export function NotesSidebar(props: {
  conflict: {
    labels: ConflictActionLabels
    path: string
  } | null
  currentPath: string | null
  emptyMessage: string
  fileCount: number
  isReady: boolean
  nodes: TreeNode[]
  onAcceptTheirs(): void
  onCreateFolder(parentPath: string | null, name: string): Promise<string | null>
  onCreateNote(parentPath: string | null, name: string): Promise<string | null>
  onDeleteEntry(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
  onOpenConflict(path: string): void
  onRenameEntry(path: string, kind: TreeNode['kind'], name: string): Promise<string | null>
  onResolveInDiff(): void
  onSaveMine(): void
  onSaveMineSeparately(): void
}) {
  const [pendingCreation, setPendingCreation] = createSignal<PendingCreation | null>(null)
  const [pendingRename, setPendingRename] = createSignal<PendingRename | null>(null)

  function clearPendingAction() {
    setPendingCreation(null)
    setPendingRename(null)
  }

  function startCreation(kind: TreeNode['kind'], parentPath: string | null) {
    setPendingRename(null)
    setPendingCreation({ kind, parentPath })
  }

  function startRename(path: string, kind: TreeNode['kind'], name: string) {
    setPendingCreation(null)

    queueMicrotask(() => {
      setPendingRename({ path, kind, name })
    })
  }

  async function submitPendingCreation(name: string): Promise<string | null> {
    const nextCreation = pendingCreation()

    if (nextCreation === null) {
      return null
    }

    if (nextCreation.kind === 'file') {
      return props.onCreateNote(nextCreation.parentPath, name)
    }

    return props.onCreateFolder(nextCreation.parentPath, name)
  }

  async function submitPendingRename(name: string): Promise<string | null> {
    const nextRename = pendingRename()

    if (nextRename === null) {
      return null
    }

    return props.onRenameEntry(nextRename.path, nextRename.kind, name)
  }

  return (
    <aside class="sidebar">
      <header>
        <h2>
          Notes
          <span>{props.fileCount}</span>
        </h2>
        <div>
          <button
            type="button"
            aria-label="New note"
            disabled={!props.isReady}
            title="New note"
            onClick={() => {
              startCreation('file', null)
            }}
          >
            <Codicon name="new-file" />
          </button>
          <button
            type="button"
            aria-label="New folder"
            disabled={!props.isReady}
            title="New folder"
            onClick={() => {
              startCreation('directory', null)
            }}
          >
            <Codicon name="new-folder" />
          </button>
        </div>
      </header>
      <Show when={props.nodes.length > 0 || pendingCreation()?.parentPath === null} fallback={<p>{props.emptyMessage}</p>}>
        <FileTree
          conflict={props.conflict}
          currentPath={props.currentPath}
          parentPath={null}
          nodes={props.nodes}
          onAcceptTheirs={props.onAcceptTheirs}
          pendingCreation={pendingCreation()}
          pendingRename={pendingRename()}
          onCancelAction={clearPendingAction}
          onCreateFolder={(path) => {
            startCreation('directory', path)
          }}
          onCreateNote={(path) => {
            startCreation('file', path)
          }}
          onDelete={props.onDeleteEntry}
          onOpen={props.onOpen}
          onOpenConflict={props.onOpenConflict}
          onResolveInDiff={props.onResolveInDiff}
          onSaveMine={props.onSaveMine}
          onSaveMineSeparately={props.onSaveMineSeparately}
          onStartRename={startRename}
          onSubmitCreation={submitPendingCreation}
          onSubmitRename={submitPendingRename}
        />
      </Show>
    </aside>
  )
}
