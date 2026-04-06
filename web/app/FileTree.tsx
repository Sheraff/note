import { For, Show, createEffect, createSignal, onMount } from 'solid-js'
import type { TreeNode } from '#web/notes/tree.ts'
import { ConflictActions, type ConflictActionLabels } from './ConflictActions.tsx'
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
  let allowBlurHandling = false

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
    window.requestAnimationFrame(() => {
      focusInput(props.initialSelection)

      window.requestAnimationFrame(() => {
        allowBlurHandling = true
      })
    })
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

            if (!allowBlurHandling) {
              window.requestAnimationFrame(() => {
                focusInput(props.initialSelection)
              })
              return
            }

            if (value().trim().length === 0) {
              props.onCancel()
              return
            }

            void submit()
          }}
          onInput={(event) => {
            allowBlurHandling = true
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

function conflictLabels(conflict: { labels: ConflictActionLabels; path: string } | null): ConflictActionLabels {
  return (
    conflict?.labels ?? {
      acceptTheirs: 'Accept file version',
      resolveInDiff: 'Resolve conflicting changes',
      saveMine: 'Save my current draft',
      saveMineSeparately: 'Save my current draft separately',
    }
  )
}

function getTreeNode(nodes: TreeNode[], path: string): TreeNode {
  const node = nodes.find((candidate) => candidate.path === path)

  if (node === undefined) {
    throw new Error(`Missing tree node for path: ${path}`)
  }

  return node
}

function FileNodeRow(props: {
  conflict: { labels: ConflictActionLabels; path: string } | null
  currentPath: string | null
  node: TreeNode
  onAcceptTheirs(): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
  onOpenConflict(path: string): void
  onResolveInDiff(): void
  onSaveMine(): void
  onSaveMineSeparately(): void
  onStartRename(path: string, kind: TreeNode['kind'], name: string): void
}) {
  const hasConflict = () => props.conflict?.path === props.node.path
  const popoverId = `tree-conflict-${props.node.path.replaceAll('/', '--')}`
  let hadFocus = false
  let renameArmed = false
  let wasFocusedOnMouseDown = false

  createEffect(() => {
    if (props.currentPath !== props.node.path) {
      renameArmed = false
    }
  })

  return (
    <div class="tree-row">
      <button
        classList={{ 'tree-entry': true, 'tree-entry-conflict': hasConflict() }}
        aria-current={props.currentPath === props.node.path ? 'true' : undefined}
        popovertarget={hasConflict() ? popoverId : undefined}
        type="button"
        onFocus={() => {
          hadFocus = true

          if (props.currentPath === props.node.path) {
            queueMicrotask(() => {
              if (props.currentPath === props.node.path) {
                renameArmed = true
              }
            })
          }
        }}
        onBlur={() => {
          hadFocus = false
        }}
        onMouseDown={(event) => {
          wasFocusedOnMouseDown = hadFocus || renameArmed

          if ((hadFocus || renameArmed) && props.currentPath === props.node.path) {
            event.preventDefault()
          }
        }}
        onClick={(event) => {
          if (hasConflict()) {
            props.onOpenConflict(props.node.path)
            return
          }

          if (props.currentPath === props.node.path && (renameArmed || wasFocusedOnMouseDown || event.detail > 1)) {
            renameArmed = false
            props.onStartRename(props.node.path, props.node.kind, props.node.name)
            return
          }

          renameArmed = false

          props.onOpen(props.node.path)
        }}
      >
        <Codicon name="file" />
        <span>{props.node.name}</span>
        <Show when={hasConflict()}>
          <Codicon name="alert" />
        </Show>
      </button>
      <Show when={hasConflict()}>
        <div id={popoverId} class="tree-conflict-popover" popover="auto">
          <ConflictActions
            labels={conflictLabels(props.conflict)}
            popoverId={popoverId}
            onAcceptTheirs={props.onAcceptTheirs}
            onResolveInDiff={props.onResolveInDiff}
            onSaveMine={props.onSaveMine}
            onSaveMineSeparately={props.onSaveMineSeparately}
          />
        </div>
      </Show>
      <div class="tree-actions">
        <button
          type="button"
          aria-label={`Rename ${props.node.path}`}
          title="Rename note"
          onClick={() => {
            props.onStartRename(props.node.path, props.node.kind, props.node.name)
          }}
        >
          <Codicon name="rename" />
        </button>
        <button
          class="tree-action-delete"
          type="button"
          aria-label={`Delete ${props.node.path}`}
          title="Delete note"
          onClick={() => {
            props.onDelete(props.node.path, props.node.kind)
          }}
        >
          <Codicon name="trash" />
        </button>
      </div>
    </div>
  )
}

function DirectoryNode(props: {
  conflict: { labels: ConflictActionLabels; path: string } | null
  currentPath: string | null
  node: TreeNode
  pendingCreation: PendingCreation | null
  pendingRename: PendingRename | null
  onAcceptTheirs(): void
  onCancelAction(): void
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
  onOpenConflict(path: string): void
  onResolveInDiff(): void
  onSaveMine(): void
  onSaveMineSeparately(): void
  onStartRename(path: string, kind: TreeNode['kind'], name: string): void
  onSubmitCreation(name: string): Promise<string | null>
  onSubmitRename(name: string): Promise<string | null>
}) {
  const [isOpen, setIsOpen] = createSignal(true)
  let hadFocus = false
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
              onFocus={() => {
                hadFocus = true
              }}
              onBlur={() => {
                hadFocus = false
              }}
              onMouseDown={(event) => {
                wasFocusedOnMouseDown = hadFocus

                if (hadFocus) {
                  event.preventDefault()
                }
              }}
              onClick={(event) => {
                if (wasFocusedOnMouseDown || event.detail > 1) {
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
          conflict={props.conflict}
          currentPath={props.currentPath}
          parentPath={props.node.path}
          nodes={props.node.children}
          onAcceptTheirs={props.onAcceptTheirs}
          pendingCreation={props.pendingCreation}
          pendingRename={props.pendingRename}
          onCancelAction={props.onCancelAction}
          onCreateFolder={props.onCreateFolder}
          onCreateNote={props.onCreateNote}
          onDelete={props.onDelete}
          onOpen={props.onOpen}
          onOpenConflict={props.onOpenConflict}
          onResolveInDiff={props.onResolveInDiff}
          onSaveMine={props.onSaveMine}
          onSaveMineSeparately={props.onSaveMineSeparately}
          onStartRename={props.onStartRename}
          onSubmitCreation={props.onSubmitCreation}
          onSubmitRename={props.onSubmitRename}
        />
      </Show>
    </>
  )
}

export function FileTree(props: {
  conflict: { labels: ConflictActionLabels; path: string } | null
  currentPath: string | null
  parentPath: string | null
  nodes: TreeNode[]
  onAcceptTheirs(): void
  pendingCreation: PendingCreation | null
  pendingRename: PendingRename | null
  onCancelAction(): void
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onOpen(path: string): void
  onOpenConflict(path: string): void
  onResolveInDiff(): void
  onSaveMine(): void
  onSaveMineSeparately(): void
  onStartRename(path: string, kind: TreeNode['kind'], name: string): void
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
      <For each={props.nodes.map((node) => node.path)}>
        {(path) => {
          let node = getTreeNode(props.nodes, path)

          const currentNode = () => {
            const nextNode = props.nodes.find((candidate) => candidate.path === path)

            if (nextNode !== undefined) {
              node = nextNode
            }

            return node
          }

          return (
            <li>
              {currentNode().kind === 'directory' ? (
                <DirectoryNode
                  conflict={props.conflict}
                  currentPath={props.currentPath}
                  node={currentNode()}
                  onAcceptTheirs={props.onAcceptTheirs}
                  pendingCreation={props.pendingCreation}
                  pendingRename={props.pendingRename}
                  onCancelAction={props.onCancelAction}
                  onCreateFolder={props.onCreateFolder}
                  onCreateNote={props.onCreateNote}
                  onDelete={props.onDelete}
                  onOpen={props.onOpen}
                  onOpenConflict={props.onOpenConflict}
                  onResolveInDiff={props.onResolveInDiff}
                  onSaveMine={props.onSaveMine}
                  onSaveMineSeparately={props.onSaveMineSeparately}
                  onStartRename={props.onStartRename}
                  onSubmitCreation={props.onSubmitCreation}
                  onSubmitRename={props.onSubmitRename}
                />
              ) : (
                <Show
                  when={props.pendingRename?.path === path ? props.pendingRename : null}
                  keyed
                  fallback={
                    <FileNodeRow
                      conflict={props.conflict}
                      currentPath={props.currentPath}
                      node={currentNode()}
                      onAcceptTheirs={props.onAcceptTheirs}
                      onDelete={props.onDelete}
                      onOpen={props.onOpen}
                      onOpenConflict={props.onOpenConflict}
                      onResolveInDiff={props.onResolveInDiff}
                      onSaveMine={props.onSaveMine}
                      onSaveMineSeparately={props.onSaveMineSeparately}
                      onStartRename={props.onStartRename}
                    />
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
