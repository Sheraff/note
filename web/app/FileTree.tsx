import { For, Show, createEffect, createSignal, onMount } from 'solid-js'
import type { TreeNode } from '#web/notes/tree.ts'
import type { ListedEntry } from '#web/storage/types.ts'
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

export type MoveDropTarget =
  | {
      kind: 'directory'
      path: string
    }
  | {
      kind: 'root'
    }

export type EntryEditorSubmitSource = 'blur' | 'enter'

function getFileRenameSelectionEnd(name: string): number {
  const extensionStart = name.lastIndexOf('.')

  return extensionStart > 0 ? extensionStart : name.length
}

function EntryEditorRow(props: {
  kind: TreeNode['kind']
  initialValue: string
  initialSelection: 'all' | 'basename'
  onCancel(): void
  onSubmit(name: string, submitSource: EntryEditorSubmitSource): Promise<string | null>
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

  async function submit(submitSource: EntryEditorSubmitSource) {
    if (isSubmitting()) {
      return
    }

    if (value().trim().length === 0) {
      props.onCancel()
      return
    }

    setIsSubmitting(true)

    try {
      const nextError = await props.onSubmit(value(), submitSource)

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

            void submit('blur')
          }}
          onInput={(event) => {
            allowBlurHandling = true
            setValue(event.currentTarget.value)
            setErrorMessage(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit('enter')
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
  onSubmit(name: string, submitSource: EntryEditorSubmitSource): Promise<string | null>
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

function hasConflictPath(conflict: { path: string } | null, conflictPaths: string[], path: string): boolean {
  return conflict?.path === path || conflictPaths.includes(path)
}

function hasDescendantConflictPath(conflict: { path: string } | null, conflictPaths: string[], path: string): boolean {
  const descendantPrefix = `${path}/`

  return (conflict?.path.startsWith(descendantPrefix) ?? false) || conflictPaths.some((conflictPath) => conflictPath.startsWith(descendantPrefix))
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
  conflictPaths: string[]
  currentPath: string | null
  draggedEntry: ListedEntry | null
  node: TreeNode
  unsavedPath: string | null
  onAcceptTheirs(): void
  onClearMoveDropTarget(): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onEndDrag(): void
  onOpen(path: string): void
  onOpenConflict(path: string): void
  onResolveInDiff(): void
  onSaveMine(): void
  onSaveMineSeparately(): void
  onStartPointerDrag(entry: ListedEntry, pointerId: number, clientX: number, clientY: number): void
  onStartDrag(entry: ListedEntry): void
  onStartRename(path: string, kind: TreeNode['kind'], name: string): void
}) {
  const hasConflict = () => hasConflictPath(props.conflict, props.conflictPaths, props.node.path)
  const hasActiveConflict = () => props.conflict?.path === props.node.path
  const hasUnsavedChanges = () => props.unsavedPath === props.node.path
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
    <div class="tree-row" data-tree-file-path={props.node.path}>
      <button
        classList={{
          'tree-entry': true,
          'tree-entry-dragging': props.draggedEntry?.path === props.node.path,
          'tree-entry-has-conflict': hasConflict(),
          'tree-entry-conflict': hasActiveConflict(),
          'tree-entry-unsaved': hasUnsavedChanges(),
        }}
        aria-current={props.currentPath === props.node.path ? 'true' : undefined}
        popovertarget={hasActiveConflict() ? popoverId : undefined}
        type="button"
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return
          }

          props.onStartPointerDrag({ kind: props.node.kind, path: props.node.path }, event.pointerId, event.clientX, event.clientY)
        }}
        onDragStart={(event) => {
          const dataTransfer = event.dataTransfer ?? null

          dataTransfer?.setData('text/plain', props.node.path)

          if (dataTransfer !== null) {
            dataTransfer.effectAllowed = 'move'
          }

          props.onStartDrag({ kind: props.node.kind, path: props.node.path })
        }}
        onDragEnd={() => {
          props.onEndDrag()
        }}
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
          if (hasActiveConflict()) {
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
        <Show when={hasUnsavedChanges()}>
          <span class="tree-entry-unsaved-indicator" aria-hidden="true" />
        </Show>
        <Show when={hasConflict()}>
          <Codicon name="alert" />
        </Show>
      </button>
      <Show when={hasActiveConflict()}>
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
  conflictPaths: string[]
  currentPath: string | null
  draggedEntry: ListedEntry | null
  dropTarget: MoveDropTarget | null
  isDirectoryOpen(path: string): boolean
  node: TreeNode
  unsavedPath: string | null
  pendingCreation: PendingCreation | null
  pendingRename: PendingRename | null
  onAcceptTheirs(): void
  canDropInDirectory(path: string): boolean
  onCancelAction(): void
  onClearMoveDropTarget(): void
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onDragOverDirectory(path: string): void
  onDropDirectory(path: string): void
  onEndDrag(): void
  onOpen(path: string): void
  onOpenConflict(path: string): void
  onSetDirectoryOpen(path: string, isOpen: boolean): void
  onResolveInDiff(): void
  onSaveMine(): void
  onSaveMineSeparately(): void
  onStartPointerDrag(entry: ListedEntry, pointerId: number, clientX: number, clientY: number): void
  onStartDrag(entry: ListedEntry): void
  onStartRename(path: string, kind: TreeNode['kind'], name: string): void
  onSubmitCreation(name: string, submitSource: EntryEditorSubmitSource): Promise<string | null>
  onSubmitRename(name: string): Promise<string | null>
}) {
  const isOpen = () => props.isDirectoryOpen(props.node.path)
  const hasClosedDescendantConflict = () => !isOpen() && hasDescendantConflictPath(props.conflict, props.conflictPaths, props.node.path)

  return (
    <>
      <Show
        when={props.pendingRename?.path === props.node.path ? props.pendingRename : null}
        keyed
        fallback={
          <div class="tree-row" data-tree-directory-path={props.node.path}>
            <button
              classList={{
                'tree-entry': true,
                'tree-entry-dragging': props.draggedEntry?.path === props.node.path,
                'tree-entry-descendant-conflict': hasClosedDescendantConflict(),
                'tree-entry-drop-target': props.dropTarget?.kind === 'directory' && props.dropTarget.path === props.node.path,
                'tree-entry-has-conflict': hasClosedDescendantConflict(),
              }}
              type="button"
              aria-expanded={isOpen() ? 'true' : 'false'}
              onPointerDown={(event) => {
                if (event.button !== 0) {
                  return
                }

                props.onStartPointerDrag({ kind: props.node.kind, path: props.node.path }, event.pointerId, event.clientX, event.clientY)
              }}
              onDragStart={(event) => {
                const dataTransfer = event.dataTransfer ?? null

                dataTransfer?.setData('text/plain', props.node.path)

                if (dataTransfer !== null) {
                  dataTransfer.effectAllowed = 'move'
                }

                props.onStartDrag({ kind: props.node.kind, path: props.node.path })
              }}
              onDragEnd={() => {
                props.onEndDrag()
              }}
              onClick={() => {
                props.onSetDirectoryOpen(props.node.path, !isOpen())
              }}
            >
              <Codicon name={isOpen() ? 'folder-opened' : 'folder'} />
              <span>{props.node.name}</span>
              <Show when={hasClosedDescendantConflict()}>
                <Codicon name="alert" />
              </Show>
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
          conflictPaths={props.conflictPaths}
          currentPath={props.currentPath}
          draggedEntry={props.draggedEntry}
          dropTarget={props.dropTarget}
          isDirectoryOpen={props.isDirectoryOpen}
          parentPath={props.node.path}
          nodes={props.node.children}
          onSetDirectoryOpen={props.onSetDirectoryOpen}
          unsavedPath={props.unsavedPath}
          onAcceptTheirs={props.onAcceptTheirs}
          canDropInDirectory={props.canDropInDirectory}
          pendingCreation={props.pendingCreation}
          pendingRename={props.pendingRename}
          onCancelAction={props.onCancelAction}
          onClearMoveDropTarget={props.onClearMoveDropTarget}
          onCreateFolder={props.onCreateFolder}
          onCreateNote={props.onCreateNote}
          onDelete={props.onDelete}
          onDragOverDirectory={props.onDragOverDirectory}
          onDropDirectory={props.onDropDirectory}
          onEndDrag={props.onEndDrag}
          onOpen={props.onOpen}
          onOpenConflict={props.onOpenConflict}
          onResolveInDiff={props.onResolveInDiff}
          onSaveMine={props.onSaveMine}
          onSaveMineSeparately={props.onSaveMineSeparately}
          onStartPointerDrag={props.onStartPointerDrag}
          onStartDrag={props.onStartDrag}
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
  conflictPaths: string[]
  currentPath: string | null
  draggedEntry: ListedEntry | null
  dropTarget: MoveDropTarget | null
  isDirectoryOpen(path: string): boolean
  parentPath: string | null
  nodes: TreeNode[]
  onSetDirectoryOpen(path: string, isOpen: boolean): void
  unsavedPath: string | null
  onAcceptTheirs(): void
  canDropInDirectory(path: string): boolean
  pendingCreation: PendingCreation | null
  pendingRename: PendingRename | null
  onCancelAction(): void
  onClearMoveDropTarget(): void
  onCreateFolder(path: string): void
  onCreateNote(path: string): void
  onDelete(path: string, kind: TreeNode['kind']): void
  onDragOverDirectory(path: string): void
  onDropDirectory(path: string): void
  onEndDrag(): void
  onOpen(path: string): void
  onOpenConflict(path: string): void
  onResolveInDiff(): void
  onSaveMine(): void
  onSaveMineSeparately(): void
  onStartPointerDrag(entry: ListedEntry, pointerId: number, clientX: number, clientY: number): void
  onStartDrag(entry: ListedEntry): void
  onStartRename(path: string, kind: TreeNode['kind'], name: string): void
  onSubmitCreation(name: string, submitSource: EntryEditorSubmitSource): Promise<string | null>
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
            <li
              data-tree-directory-drop-path={currentNode().kind === 'directory' ? currentNode().path : undefined}
              onDragOver={(event) => {
                if (currentNode().kind !== 'directory' || props.draggedEntry === null || !props.canDropInDirectory(currentNode().path)) {
                  return
                }

                const target = event.target

                if (!(target instanceof Element)) {
                  return
                }

                if (target.closest('[data-tree-directory-drop-path]') !== event.currentTarget) {
                  return
                }

                event.preventDefault()
                event.stopPropagation()

                const dataTransfer = event.dataTransfer ?? null

                if (dataTransfer !== null) {
                  dataTransfer.dropEffect = 'move'
                }

                props.onDragOverDirectory(currentNode().path)
              }}
              onDrop={(event) => {
                if (currentNode().kind !== 'directory' || props.draggedEntry === null || !props.canDropInDirectory(currentNode().path)) {
                  return
                }

                const target = event.target

                if (!(target instanceof Element)) {
                  return
                }

                if (target.closest('[data-tree-directory-drop-path]') !== event.currentTarget) {
                  return
                }

                event.preventDefault()
                event.stopPropagation()
                props.onDropDirectory(currentNode().path)
              }}
            >
              {currentNode().kind === 'directory' ? (
                    <DirectoryNode
                      conflict={props.conflict}
                      conflictPaths={props.conflictPaths}
                      currentPath={props.currentPath}
                      draggedEntry={props.draggedEntry}
                      dropTarget={props.dropTarget}
                      isDirectoryOpen={props.isDirectoryOpen}
                      node={currentNode()}
                      unsavedPath={props.unsavedPath}
                      onAcceptTheirs={props.onAcceptTheirs}
                      canDropInDirectory={props.canDropInDirectory}
                      pendingCreation={props.pendingCreation}
                      pendingRename={props.pendingRename}
                  onCancelAction={props.onCancelAction}
                  onClearMoveDropTarget={props.onClearMoveDropTarget}
                  onCreateFolder={props.onCreateFolder}
                  onCreateNote={props.onCreateNote}
                  onDelete={props.onDelete}
                  onDragOverDirectory={props.onDragOverDirectory}
                  onDropDirectory={props.onDropDirectory}
                  onEndDrag={props.onEndDrag}
                  onOpen={props.onOpen}
                  onOpenConflict={props.onOpenConflict}
                  onSetDirectoryOpen={props.onSetDirectoryOpen}
                  onResolveInDiff={props.onResolveInDiff}
                  onSaveMine={props.onSaveMine}
                  onSaveMineSeparately={props.onSaveMineSeparately}
                  onStartPointerDrag={props.onStartPointerDrag}
                  onStartDrag={props.onStartDrag}
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
                      conflictPaths={props.conflictPaths}
                      currentPath={props.currentPath}
                      draggedEntry={props.draggedEntry}
                      node={currentNode()}
                      unsavedPath={props.unsavedPath}
                      onAcceptTheirs={props.onAcceptTheirs}
                      onClearMoveDropTarget={props.onClearMoveDropTarget}
                      onDelete={props.onDelete}
                      onEndDrag={props.onEndDrag}
                      onOpen={props.onOpen}
                      onOpenConflict={props.onOpenConflict}
                      onResolveInDiff={props.onResolveInDiff}
                      onSaveMine={props.onSaveMine}
                      onSaveMineSeparately={props.onSaveMineSeparately}
                      onStartPointerDrag={props.onStartPointerDrag}
                      onStartDrag={props.onStartDrag}
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
