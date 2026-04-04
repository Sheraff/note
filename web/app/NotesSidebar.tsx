import { Show } from 'solid-js'
import type { TreeNode } from '../notes/tree.ts'
import { FileTree } from './FileTree.tsx'
import './NotesSidebar.css'

export function NotesSidebar(props: {
  currentPath: string | null
  fileCount: number
  nodes: TreeNode[]
  onOpen(path: string): void
}) {
  return (
    <aside class="sidebar">
      <header>
        <h2>Notes</h2>
        <span>{props.fileCount}</span>
      </header>
      <Show when={props.nodes.length > 0} fallback={<p>Create a note to start writing.</p>}>
        <FileTree currentPath={props.currentPath} nodes={props.nodes} onOpen={props.onOpen} />
      </Show>
    </aside>
  )
}
