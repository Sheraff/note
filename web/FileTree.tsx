import { For, Match, Switch, createSignal } from 'solid-js'
import { Codicon } from './Codicon.tsx'
import type { TreeNode } from './notes/tree.ts'

function DirectoryNode(props: {
  currentPath: string | null
  node: TreeNode
  onOpen(path: string): void
}) {
  const [isOpen, setIsOpen] = createSignal(true)

  return (
    <details open={isOpen()} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary>
        <Codicon name={isOpen() ? 'folder-opened' : 'folder'} />
        {props.node.name}
      </summary>
      <FileTree currentPath={props.currentPath} nodes={props.node.children} onOpen={props.onOpen} />
    </details>
  )
}

export function FileTree(props: {
  currentPath: string | null
  nodes: TreeNode[]
  onOpen(path: string): void
}) {
  return (
    <ul class="tree">
      <For each={props.nodes}>
        {(node) => (
          <li>
            <Switch>
              <Match when={node.kind === 'directory'}>
                <DirectoryNode currentPath={props.currentPath} node={node} onOpen={props.onOpen} />
              </Match>
              <Match when={node.kind === 'file'}>
                <button
                  classList={{ active: props.currentPath === node.path }}
                  type="button"
                  onClick={() => {
                    props.onOpen(node.path)
                  }}
                >
                  <Codicon name="file" />
                  {node.name}
                </button>
              </Match>
            </Switch>
          </li>
        )}
      </For>
    </ul>
  )
}
