import { Show } from 'solid-js'
import type { TreeNode } from '../notes/tree.ts'
import { Codicon } from './Codicon.tsx'
import { FileTree } from './FileTree.tsx'
import './NotesSidebar.css'

export function NotesSidebar(props: {
  currentPath: string | null
  fileCount: number
  nodes: TreeNode[]
  onCreateFolder(): void
  onCreateFolderInDirectory(path: string): void
  onCreateNote(): void
  onCreateNoteInDirectory(path: string): void
  onDeleteEntry(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
}) {
  return (
    <aside class="sidebar">
      <header>
        <h2>
          Notes
          <span>{props.fileCount}</span>
        </h2>
        <div>
          <button type="button" aria-label="New note" title="New note" onClick={props.onCreateNote}>
            <Codicon name="new-file" />
          </button>
          <button type="button" aria-label="New folder" title="New folder" onClick={props.onCreateFolder}>
            <Codicon name="new-folder" />
          </button>
        </div>
      </header>
      <Show when={props.nodes.length > 0} fallback={<p>Create a note to start writing.</p>}>
        <FileTree
          currentPath={props.currentPath}
          nodes={props.nodes}
          onCreateFolder={props.onCreateFolderInDirectory}
          onCreateNote={props.onCreateNoteInDirectory}
          onDelete={props.onDeleteEntry}
          onOpen={props.onOpen}
        />
      </Show>
    </aside>
  )
}
