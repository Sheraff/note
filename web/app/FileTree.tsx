import { For, Show, createEffect, createSignal, onMount } from 'solid-js'
import type { TreeNode } from '#web/notes/tree.ts'
import { Codicon } from './Codicon.tsx'
import './FileTree.css'

export type PendingCreation = {
  kind: TreeNode['kind']
  parentPath: string | null
}

export type PendingRename = {
  kind: TreeNode['kind']
  path: string
  name: string
}

function getFileRenameSelectionEnd(name: string): number {
  const extensionStart = name.lastIndexOf('.')

  return extensionStart > 0 ? extensionStart : name.length
}

function EntryEditorRow(props: {
  kind: TreeNode['kind']
  initialValue: string
  initialSelection: 'all' | 'basename'
  onCancel(): void
  onSubmit(name: string): Promise<string | null>
}) {
  let inputElement: HTMLInputElement | undefined

  const [value, setValue] = createSignal(props.initialValue)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [isSubmitting, setIsSubmitting] = createSignal(false)

  function focusInput(selection: 'none' | 'all' | 'basename') {
    inputElement?.focus()

    if (selection === 'all') {
      inputElement?.select()
      return
    }

    if (selection === 'basename') {
      inputElement?.setSelectionRange(0, getFileRenameSelectionEnd(value()))
    }
  }

  onMount(() => {
    focusInput(props.initialSelection)
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
        focusInput('none')
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div class="tree-row tree-row-editor">
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

function CreateRow(props: {
  kind: TreeNode['kind']
  onCancel(): void
  onSubmit(name: string): Promise<string | null>
}) {
  return (
    <EntryEditorRow
      kind={props.kind}
      initialValue={props.kind === 'file' ? 'untitled.md' : 'untitled'}
      initialSelection="all"
      onCancel={props.onCancel}
      onSubmit={props.onSubmit}
    />
  )
}

function DirectoryNode(props: {
  currentPath: string | null
  node: TreeNode
  pendingCreation: PendingCreation | null
  pendingRename: PendingRename | null
  onCancelAction(): void
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onStartRename(path: string, kind: TreeNode['kind'], name: string): void
  onOpen(path: string): void
  onSubmitCreation(name: string): Promise<string | null>
  onSubmitRename(name: string): Promise<string | null>
}) {
  const [isOpen, setIsOpen] = createSignal(true)
  let wasFocusedOnMouseDown = false

  createEffect(() => {
    if (props.pendingCreation?.parentPath === props.node.path) {
      setIsOpen(true)
    }
  })

  return (
    <>
      <Show
        when={props.pendingRename?.path === props.node.path ? props.pendingRename : null}
        keyed
        fallback={
          <div class="tree-row">
            <button
              class="tree-entry"
              type="button"
              aria-expanded={isOpen() ? 'true' : 'false'}
              onMouseDown={(event) => {
                wasFocusedOnMouseDown = document.activeElement === event.currentTarget
              }}
              onClick={() => {
                if (wasFocusedOnMouseDown) {
                  props.onStartRename(props.node.path, props.node.kind, props.node.name)
                  return
                }

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
                aria-label={`Rename folder ${props.node.path}`}
                title="Rename folder"
                onClick={() => {
                  props.onStartRename(props.node.path, props.node.kind, props.node.name)
                }}
              >
                <Codicon name="rename" />
              </button>
              <button
                class="tree-action-delete"
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
        }
      >
        {(pendingRename) => (
          <EntryEditorRow
            kind={pendingRename.kind}
            initialValue={pendingRename.name}
            initialSelection={pendingRename.kind === 'file' ? 'basename' : 'all'}
            onCancel={props.onCancelAction}
            onSubmit={props.onSubmitRename}
          />
        )}
      </Show>
      <Show when={isOpen()}>
        <FileTree
          currentPath={props.currentPath}
          parentPath={props.node.path}
          nodes={props.node.children}
          pendingCreation={props.pendingCreation}
          pendingRename={props.pendingRename}
          onCancelAction={props.onCancelAction}
          onCreateFolder={props.onCreateFolder}
          onCreateNote={props.onCreateNote}
          onDelete={props.onDelete}
          onStartRename={props.onStartRename}
          onOpen={props.onOpen}
          onSubmitCreation={props.onSubmitCreation}
          onSubmitRename={props.onSubmitRename}
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
  pendingRename: PendingRename | null
  onCancelAction(): void
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onStartRename(path: string, kind: TreeNode['kind'], name: string): void
  onOpen(path: string): void
  onSubmitCreation(name: string): Promise<string | null>
  onSubmitRename(name: string): Promise<string | null>
}) {
  return (
    <ul class="tree">
      <Show when={props.pendingCreation?.parentPath === props.parentPath ? props.pendingCreation : null} keyed>
        {(pendingCreation) => (
          <li>
            <CreateRow kind={pendingCreation.kind} onCancel={props.onCancelAction} onSubmit={props.onSubmitCreation} />
          </li>
        )}
      </Show>
      <For each={props.nodes}>
        {(node) => {
          let wasFocusedOnMouseDown = false

          return (
            <li>
              {node.kind === 'directory' ? (
                <DirectoryNode
                  currentPath={props.currentPath}
                  node={node}
                  pendingCreation={props.pendingCreation}
                  pendingRename={props.pendingRename}
                  onCancelAction={props.onCancelAction}
                  onCreateFolder={props.onCreateFolder}
                  onCreateNote={props.onCreateNote}
                  onDelete={props.onDelete}
                  onStartRename={props.onStartRename}
                  onOpen={props.onOpen}
                  onSubmitCreation={props.onSubmitCreation}
                  onSubmitRename={props.onSubmitRename}
                />
              ) : (
                <Show
                  when={props.pendingRename?.path === node.path ? props.pendingRename : null}
                  keyed
                  fallback={
                    <div class="tree-row">
                      <button
                        class="tree-entry"
                        aria-current={props.currentPath === node.path ? 'true' : undefined}
                        type="button"
                        onMouseDown={(event) => {
                          wasFocusedOnMouseDown = document.activeElement === event.currentTarget
                        }}
                        onClick={() => {
                          if (wasFocusedOnMouseDown && props.currentPath === node.path) {
                            props.onStartRename(node.path, node.kind, node.name)
                            return
                          }

                          props.onOpen(node.path)
                        }}
                      >
                        <Codicon name="file" />
                        <span>{node.name}</span>
                      </button>
                      <div class="tree-actions">
                        <button
                          type="button"
                          aria-label={`Rename ${node.path}`}
                          title="Rename note"
                          onClick={() => {
                            props.onStartRename(node.path, node.kind, node.name)
                          }}
                        >
                          <Codicon name="rename" />
                        </button>
                        <button
                          class="tree-action-delete"
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
                  }
                >
                  {(pendingRename) => (
                    <EntryEditorRow
                      kind={pendingRename.kind}
                      initialValue={pendingRename.name}
                      initialSelection={pendingRename.kind === 'file' ? 'basename' : 'all'}
                      onCancel={props.onCancelAction}
                      onSubmit={props.onSubmitRename}
                    />
                  )}
                </Show>
              )}
            </li>
          )
        }}
      </For>
    </ul>
  )
}
