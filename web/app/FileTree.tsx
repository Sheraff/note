import { For, Show, createSignal } from 'solid-js'
import { Codicon } from './Codicon.tsx'
import type { TreeNode } from '#web/notes/tree.ts'
import './FileTree.css'

function DirectoryNode(props: {
  currentPath: string | null
  node: TreeNode
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
}) {
  const [isOpen, setIsOpen] = createSignal(true)

  return (
    <>
      <div class="tree-row">
        <button
          type="button"
          aria-expanded={isOpen() ? 'true' : 'false'}
          onClick={() => {
            setIsOpen(!isOpen())
          }}
        >
          <Codicon name={isOpen() ? 'folder-opened' : 'folder'} />
          <span>{props.node.name}</span>
        </button>
        <div class="tree-actions">
          <button
            type="button"
            aria-label={`New note in ${props.node.path}`}
            title="New note"
            onClick={() => {
              props.onCreateNote(props.node.path)
            }}
          >
            <Codicon name="new-file" />
          </button>
          <button
            type="button"
            aria-label={`New folder in ${props.node.path}`}
            title="New folder"
            onClick={() => {
              props.onCreateFolder(props.node.path)
            }}
          >
            <Codicon name="new-folder" />
          </button>
          <button
            type="button"
            aria-label={`Delete folder ${props.node.path}`}
            title="Delete folder"
            onClick={() => {
              props.onDelete(props.node.path, props.node.kind)
            }}
          >
            <Codicon name="trash" />
          </button>
        </div>
      </div>
      <Show when={isOpen()}>
        <FileTree
          currentPath={props.currentPath}
          nodes={props.node.children}
          onCreateFolder={props.onCreateFolder}
          onCreateNote={props.onCreateNote}
          onDelete={props.onDelete}
          onOpen={props.onOpen}
        />
      </Show>
    </>
  )
}

export function FileTree(props: {
  currentPath: string | null
  nodes: TreeNode[]
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
}) {
  return (
    <ul class="tree">
      <For each={props.nodes}>
        {(node) => (
          <li>
            {node.kind === 'directory' ? (
              <DirectoryNode
                currentPath={props.currentPath}
                node={node}
                onCreateFolder={props.onCreateFolder}
                onCreateNote={props.onCreateNote}
                onDelete={props.onDelete}
                onOpen={props.onOpen}
              />
            ) : (
              <div class="tree-row">
                <button
                  aria-current={props.currentPath === node.path ? 'true' : undefined}
                  type="button"
                  onClick={() => {
                    props.onOpen(node.path)
                  }}
                >
                  <Codicon name="file" />
                  <span>{node.name}</span>
                </button>
                <div class="tree-actions">
                  <button
                    type="button"
                    aria-label={`Delete ${node.path}`}
                    title="Delete note"
                    onClick={() => {
                      props.onDelete(node.path, node.kind)
                    }}
                  >
                    <Codicon name="trash" />
                  </button>
                </div>
              </div>
            )}
          </li>
        )}
      </For>
    </ul>
  )
}
