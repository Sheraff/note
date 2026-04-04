import { For, Show, createEffect, createSignal, onMount } from 'solid-js'
import { Codicon } from './Codicon.tsx'
import type { TreeNode } from '#web/notes/tree.ts'
import './FileTree.css'

type PendingCreation = {
  kind: TreeNode['kind']
  parentPath: string | null
}

function CreateRow(props: {
  kind: TreeNode['kind']
  onCancel(): void
  onSubmit(name: string): Promise<string | null>
}) {
  let inputElement: HTMLInputElement | undefined

  const [value, setValue] = createSignal(props.kind === 'file' ? 'untitled.md' : 'untitled')
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [isSubmitting, setIsSubmitting] = createSignal(false)

  function focusInput(selectText: boolean) {
    inputElement?.focus()

    if (selectText) {
      inputElement?.select()
    }
  }

  onMount(() => {
    focusInput(true)
  })

  async function submit() {
    if (isSubmitting()) {
      return
    }

    if (value().trim().length === 0) {
      props.onCancel()
      return
    }

    setIsSubmitting(true)

    try {
      const nextError = await props.onSubmit(value())

      if (nextError === null) {
        props.onCancel()
        return
      }

      setErrorMessage(nextError)
      window.requestAnimationFrame(() => {
        focusInput(false)
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div class="tree-row tree-row-create">
      <div class="tree-entry">
        <Codicon name={props.kind === 'directory' ? 'folder' : 'file'} />
        <input
          ref={inputElement}
          type="text"
          value={value()}
          spellcheck={false}
          aria-invalid={errorMessage() !== null ? 'true' : 'false'}
          onBlur={() => {
            if (isSubmitting()) {
              return
            }

            if (value().trim().length === 0) {
              props.onCancel()
              return
            }

            void submit()
          }}
          onInput={(event) => {
            setValue(event.currentTarget.value)
            setErrorMessage(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }

            if (event.key === 'Escape') {
              event.preventDefault()
              props.onCancel()
            }
          }}
        />
        <Show when={errorMessage() !== null}>
          <div role="alert">{errorMessage()}</div>
        </Show>
      </div>
    </div>
  )
}

function DirectoryNode(props: {
  currentPath: string | null
  node: TreeNode
  pendingCreation: PendingCreation | null
  onCancelCreation(): void
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
  onSubmitCreation(name: string): Promise<string | null>
}) {
  const [isOpen, setIsOpen] = createSignal(true)

  createEffect(() => {
    if (props.pendingCreation?.parentPath === props.node.path) {
      setIsOpen(true)
    }
  })

  return (
    <>
      <div class="tree-row">
        <button
          class="tree-entry"
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
          parentPath={props.node.path}
          nodes={props.node.children}
          pendingCreation={props.pendingCreation}
          onCancelCreation={props.onCancelCreation}
          onCreateFolder={props.onCreateFolder}
          onCreateNote={props.onCreateNote}
          onDelete={props.onDelete}
          onOpen={props.onOpen}
          onSubmitCreation={props.onSubmitCreation}
        />
      </Show>
    </>
  )
}

export function FileTree(props: {
  currentPath: string | null
  parentPath: string | null
  nodes: TreeNode[]
  pendingCreation: PendingCreation | null
  onCancelCreation(): void
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
  onSubmitCreation(name: string): Promise<string | null>
}) {
  return (
    <ul class="tree">
      <Show when={props.pendingCreation?.parentPath === props.parentPath ? props.pendingCreation : null} keyed>
        {(pendingCreation) => (
          <li>
            <CreateRow kind={pendingCreation.kind} onCancel={props.onCancelCreation} onSubmit={props.onSubmitCreation} />
          </li>
        )}
      </Show>
      <For each={props.nodes}>
        {(node) => (
          <li>
            {node.kind === 'directory' ? (
              <DirectoryNode
                currentPath={props.currentPath}
                node={node}
                pendingCreation={props.pendingCreation}
                onCancelCreation={props.onCancelCreation}
                onCreateFolder={props.onCreateFolder}
                onCreateNote={props.onCreateNote}
                onDelete={props.onDelete}
                onOpen={props.onOpen}
                onSubmitCreation={props.onSubmitCreation}
              />
            ) : (
              <div class="tree-row">
                <button
                  class="tree-entry"
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
