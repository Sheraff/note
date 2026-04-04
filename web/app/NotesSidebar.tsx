import { Show, createSignal } from 'solid-js'
import type { TreeNode } from '../notes/tree.ts'
import { Codicon } from './Codicon.tsx'
import { FileTree } from './FileTree.tsx'
import './NotesSidebar.css'

type PendingCreation = {
  kind: TreeNode['kind']
  parentPath: string | null
}

export function NotesSidebar(props: {
  currentPath: string | null
  fileCount: number
  nodes: TreeNode[]
  onCreateFolder(parentPath: string | null, name: string): Promise<string | null>
  onCreateNote(parentPath: string | null, name: string): Promise<string | null>
  onDeleteEntry(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
}) {
  const [pendingCreation, setPendingCreation] = createSignal<PendingCreation | null>(null)

  function startCreation(kind: TreeNode['kind'], parentPath: string | null) {
    setPendingCreation({ kind, parentPath })
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
            title="New folder"
            onClick={() => {
              startCreation('directory', null)
            }}
          >
            <Codicon name="new-folder" />
          </button>
        </div>
      </header>
      <Show when={props.nodes.length > 0 || pendingCreation()?.parentPath === null} fallback={<p>Create a note to start writing.</p>}>
        <FileTree
          currentPath={props.currentPath}
          parentPath={null}
          nodes={props.nodes}
          pendingCreation={pendingCreation()}
          onCancelCreation={() => {
            setPendingCreation(null)
          }}
          onCreateFolder={(path) => {
            startCreation('directory', path)
          }}
          onCreateNote={(path) => {
            startCreation('file', path)
          }}
          onDelete={props.onDeleteEntry}
          onOpen={props.onOpen}
          onSubmitCreation={submitPendingCreation}
        />
      </Show>
    </aside>
  )
}
