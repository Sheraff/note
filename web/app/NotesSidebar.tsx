import { createHotkeyHandler } from '@tanstack/hotkeys'
import { Show, createMemo, createSignal, onCleanup } from 'solid-js'
import { getName, getParentPath, joinNotePath } from '../notes/paths.ts'
import type { TreeNode } from '../notes/tree.ts'
import type { ListedEntry } from '../storage/types.ts'
import { Codicon } from './Codicon.tsx'
import { type ConflictActionLabels } from './ConflictActions.tsx'
import { FileTree, type EntryEditorSubmitSource, type MoveDropTarget, type PendingCreation, type PendingRename } from './FileTree.tsx'
import './NotesSidebar.css'

type DirectoryMoveState = {
  fromPath: string
  nextPersistedOpenDirectoryPaths: string[]
  previousPersistedOpenDirectoryPaths: string[]
  toPath: string
}

function arePathArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

function serializePathSet(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort()
}

function collectPathChain(path: string): string[] {
  const directoryPaths: string[] = []
  let currentPath: string | null = path

  while (currentPath !== null) {
    directoryPaths.unshift(currentPath)
    currentPath = getParentPath(currentPath)
  }

  return directoryPaths
}

function updatePathArray(current: string[], paths: Iterable<string>, isPresent: boolean): string[] {
  const next = new Set(current)

  for (const path of paths) {
    if (isPresent) {
      next.add(path)
      continue
    }

    next.delete(path)
  }

  return serializePathSet(next)
}

function movePath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath || path.startsWith(`${fromPath}/`)) {
    return `${toPath}${path.slice(fromPath.length)}`
  }

  return path
}

function movePathArray(current: string[], fromPath: string, toPath: string): string[] {
  return serializePathSet(current.map((path) => movePath(path, fromPath, toPath)))
}

function getVisibleOpenDirectoryPaths(options: {
  knownDirectoryPaths: Set<string>
  persistedOpenDirectoryPaths: string[]
}): Set<string> {
  const openDirectoryPaths = new Set<string>()

  for (const path of options.persistedOpenDirectoryPaths) {
    if (options.knownDirectoryPaths.has(path)) {
      openDirectoryPaths.add(path)
    }
  }

  return openDirectoryPaths
}

function collectDirectoryPaths(nodes: TreeNode[]): Set<string> {
  const paths = new Set<string>()

  for (const node of nodes) {
    if (node.kind !== 'directory') {
      continue
    }

    paths.add(node.path)

    for (const childPath of collectDirectoryPaths(node.children)) {
      paths.add(childPath)
    }
  }

  return paths
}

export function NotesSidebar(props: {
  conflict: {
    labels: ConflictActionLabels
    path: string
  } | null
  conflictPaths: string[]
  currentPath: string | null
  emptyMessage: string
  fileCount: number
  isReady: boolean
  nodes: TreeNode[]
  persistedOpenDirectoryPaths: string[]
  unsavedPath: string | null
  onAcceptTheirs(): void
  onCreateFolder(parentPath: string | null, name: string): Promise<string | null>
  onCreateNote(parentPath: string | null, name: string, submitSource: EntryEditorSubmitSource): Promise<string | null>
  onDeleteEntry(path: string, kind: TreeNode['kind']): void
  onMoveEntry(entry: ListedEntry, parentPath: string | null): Promise<boolean>
  onOpen(path: string): void
  onPersistedOpenDirectoryPathsChange(paths: string[]): void
  onOpenConflict(path: string): void
  onRenameEntry(path: string, kind: TreeNode['kind'], name: string): Promise<string | null>
  onResolveInDiff(): void
  onSaveMine(): void
  onSaveMineSeparately(): void
}) {
  const [pendingCreation, setPendingCreation] = createSignal<PendingCreation | null>(null)
  const [pendingRename, setPendingRename] = createSignal<PendingRename | null>(null)
  const [pendingPersistedOpenDirectoryPaths, setPendingPersistedOpenDirectoryPaths] = createSignal<string[] | null>(null)
  const [draggedEntry, setDraggedEntry] = createSignal<ListedEntry | null>(null)
  const [dropTarget, setDropTarget] = createSignal<MoveDropTarget | null>(null)
  const [dragPreviewPosition, setDragPreviewPosition] = createSignal<{ x: number; y: number } | null>(null)
  let suppressTreeClickCleanup: (() => void) | null = null
  let pointerDrag:
    | {
      clientX: number
      clientY: number
      entry: ListedEntry
      pointerId: number
      started: boolean
    }
    | null = null
  let hoverOpenPath: string | null = null
  let hoverOpenTimeout: number | undefined

  const knownDirectoryPaths = createMemo(() => collectDirectoryPaths(props.nodes))
  const effectivePersistedOpenDirectoryPaths = createMemo(() => {
    const pending = pendingPersistedOpenDirectoryPaths()

    return pending !== null && !arePathArraysEqual(pending, props.persistedOpenDirectoryPaths)
      ? pending
      : props.persistedOpenDirectoryPaths
  })
  const visibleOpenDirectoryPaths = createMemo(() => getVisibleOpenDirectoryPaths({
    knownDirectoryPaths: knownDirectoryPaths(),
    persistedOpenDirectoryPaths: effectivePersistedOpenDirectoryPaths(),
  }))

  function setPersistedOpenDirectoryPaths(nextPersistedOpenDirectoryPaths: string[], persist = true) {
    const normalizedOpenDirectoryPaths = serializePathSet(nextPersistedOpenDirectoryPaths)

    if (arePathArraysEqual(normalizedOpenDirectoryPaths, effectivePersistedOpenDirectoryPaths())) {
      return
    }

    setPendingPersistedOpenDirectoryPaths(normalizedOpenDirectoryPaths)
    if (!persist) {
      return
    }

    props.onPersistedOpenDirectoryPathsChange(normalizedOpenDirectoryPaths)
  }

  function openDirectoryChain(path: string) {
    setPersistedOpenDirectoryPaths(updatePathArray(effectivePersistedOpenDirectoryPaths(), collectPathChain(path), true))
  }

  function setDirectoryOpen(path: string, isOpen: boolean) {
    setPersistedOpenDirectoryPaths(updatePathArray(effectivePersistedOpenDirectoryPaths(), [path], isOpen))
  }

  function isDirectoryOpen(path: string): boolean {
    return visibleOpenDirectoryPaths().has(path)
  }

  function clearPendingAction() {
    setPendingCreation(null)
    setPendingRename(null)
  }

  function clearHoverOpenTimer() {
    hoverOpenPath = null

    if (hoverOpenTimeout !== undefined) {
      window.clearTimeout(hoverOpenTimeout)
      hoverOpenTimeout = undefined
    }
  }

  function clearDragState() {
    setDraggedEntry(null)
    setDragPreviewPosition(null)
    setDropTarget(null)
    clearHoverOpenTimer()
  }

  function canDropInDirectory(entry: ListedEntry, path: string): boolean {
    if (entry.kind !== 'directory') {
      return true
    }

    return path !== entry.path && !path.startsWith(`${entry.path}/`)
  }

  function captureDirectoryMoveState(path: string, parentPath: string | null): DirectoryMoveState | null {
    const toPath = joinNotePath(parentPath, getName(path))

    if (toPath === path) {
      return null
    }

    const previousPersistedOpenDirectoryPaths = effectivePersistedOpenDirectoryPaths()

    return {
      fromPath: path,
      nextPersistedOpenDirectoryPaths: movePathArray(previousPersistedOpenDirectoryPaths, path, toPath),
      previousPersistedOpenDirectoryPaths,
      toPath,
    }
  }

  function previewDirectoryMoveState(moveState: DirectoryMoveState) {
    setPendingPersistedOpenDirectoryPaths(moveState.nextPersistedOpenDirectoryPaths)
  }

  function revertDirectoryMoveState(moveState: DirectoryMoveState) {
    setPendingPersistedOpenDirectoryPaths(moveState.previousPersistedOpenDirectoryPaths)
  }

  function applyDirectoryMoveState(moveState: DirectoryMoveState) {
    setPersistedOpenDirectoryPaths(moveState.nextPersistedOpenDirectoryPaths)
  }

  async function moveEntry(entry: ListedEntry, parentPath: string | null) {
    const moveState = entry.kind === 'directory' ? captureDirectoryMoveState(entry.path, parentPath) : null

    if (moveState !== null) {
      previewDirectoryMoveState(moveState)
    }

    const didMove = await props.onMoveEntry(entry, parentPath)

    if (!didMove && moveState !== null) {
      revertDirectoryMoveState(moveState)
      return
    }

    if (didMove && moveState !== null) {
      applyDirectoryMoveState(moveState)
    }
  }

  function clearSuppressedTreeClick() {
    suppressTreeClickCleanup?.()
    suppressTreeClickCleanup = null
  }

  function suppressNextTreeClick() {
    clearSuppressedTreeClick()

    const timeout = window.setTimeout(() => {
      clearSuppressedTreeClick()
    }, 250)
    const handleClick = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      clearSuppressedTreeClick()
    }

    document.addEventListener('click', handleClick, true)
    suppressTreeClickCleanup = () => {
      window.clearTimeout(timeout)
      document.removeEventListener('click', handleClick, true)
    }
  }

  function stopPointerDrag() {
    pointerDrag = null
    document.removeEventListener('pointermove', handlePointerMove, true)
    document.removeEventListener('pointerup', handlePointerUp, true)
    document.removeEventListener('pointercancel', handlePointerCancel, true)
  }

  function updatePointerDropTarget(clientX: number, clientY: number) {
    const target = document.elementFromPoint(clientX, clientY)

    if (!(target instanceof HTMLElement)) {
      setMoveDropTarget(null)
      return
    }

    const directoryTarget = target.closest<HTMLElement>('[data-tree-directory-drop-path]')

    if (target.closest('[data-tree-file-path]') !== null) {
      const path = directoryTarget?.dataset.treeDirectoryDropPath

      if (path !== undefined) {
        setMoveDropTarget({ kind: 'directory', path })
        return
      }

      if (target.closest('[data-tree-root-dropzone]') !== null) {
        setMoveDropTarget({ kind: 'root' })
        return
      }

      setMoveDropTarget(null)
      return
    }

    const directoryRow = target.closest<HTMLElement>('[data-tree-directory-path]')

    if (directoryRow !== null) {
      const path = directoryRow.dataset.treeDirectoryPath

      if (path !== undefined) {
        setMoveDropTarget({ kind: 'directory', path })
        return
      }
    }

    if (directoryTarget !== null) {
      const path = directoryTarget.dataset.treeDirectoryDropPath

      if (path !== undefined) {
        setMoveDropTarget({ kind: 'directory', path })
        return
      }
    }

    if (target.closest('[data-tree-root-dropzone]') !== null) {
      setMoveDropTarget({ kind: 'root' })
      return
    }

    setMoveDropTarget(null)
  }

  function handlePointerMove(event: PointerEvent) {
    if (pointerDrag === null || event.pointerId !== pointerDrag.pointerId) {
      return
    }

    if (!pointerDrag.started) {
      const deltaX = event.clientX - pointerDrag.clientX
      const deltaY = event.clientY - pointerDrag.clientY

      if (Math.hypot(deltaX, deltaY) < 4) {
        return
      }

      pointerDrag.started = true
      setDraggedEntry(pointerDrag.entry)
    }

    setDragPreviewPosition({
      x: event.clientX,
      y: event.clientY,
    })
    updatePointerDropTarget(event.clientX, event.clientY)
  }

  function handlePointerUp(event: PointerEvent) {
    if (pointerDrag === null || event.pointerId !== pointerDrag.pointerId) {
      return
    }

    const activeDrag = pointerDrag
    const target = dropTarget()

    stopPointerDrag()
    clearDragState()

    if (activeDrag.started) {
      suppressNextTreeClick()
    }

    if (!activeDrag.started || target === null) {
      return
    }

    void moveEntry(activeDrag.entry, target.kind === 'directory' ? target.path : null)
  }

  function handlePointerCancel(event: PointerEvent) {
    if (pointerDrag === null || event.pointerId !== pointerDrag.pointerId) {
      return
    }

    stopPointerDrag()
    clearDragState()
  }

  function scheduleHoverOpen(path: string) {
    if (isDirectoryOpen(path) || hoverOpenPath === path) {
      return
    }

    clearHoverOpenTimer()
    hoverOpenPath = path
    hoverOpenTimeout = window.setTimeout(() => {
      const nextPath = hoverOpenPath

      hoverOpenPath = null
      hoverOpenTimeout = undefined

      if (nextPath !== null) {
        setDirectoryOpen(nextPath, true)
      }
    }, 1000)
  }

  function setMoveDropTarget(target: MoveDropTarget | null) {
    const currentDraggedEntry = draggedEntry()
    const nextTarget =
      target?.kind === 'directory' && currentDraggedEntry !== null && !canDropInDirectory(currentDraggedEntry, target.path)
        ? null
        : target

    setDropTarget((current) => {
      const currentPath = current?.kind === 'directory' ? current.path : null
      const nextPath = nextTarget?.kind === 'directory' ? nextTarget.path : null

      if (current?.kind === nextTarget?.kind && currentPath === nextPath) {
        return current
      }

      return nextTarget
    })

    if (nextTarget?.kind === 'directory') {
      if (hoverOpenPath !== null && hoverOpenPath !== nextTarget.path) {
        clearHoverOpenTimer()
      }

      scheduleHoverOpen(nextTarget.path)
      return
    }

    clearHoverOpenTimer()
  }

  function startCreation(kind: TreeNode['kind'], parentPath: string | null) {
    if (parentPath !== null) {
      openDirectoryChain(parentPath)
    }

    setPendingRename(null)
    setPendingCreation({ kind, parentPath })
  }

  function startRename(path: string, kind: TreeNode['kind'], name: string) {
    setPendingCreation(null)
    setPendingRename({ path, kind, name })
  }

  function shouldHandleNewNoteShortcut(event: KeyboardEvent): boolean {
    const target = event.target

    if (!(target instanceof HTMLElement)) {
      return true
    }

    if (target.closest('.monaco-editor') !== null) {
      return true
    }

    return !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable)
  }

  if (typeof document !== 'undefined') {
    const handleNewNoteHotkey = createHotkeyHandler(
      'Mod+Alt+N',
      (event) => {
        event.preventDefault()
        event.stopPropagation()

        if (!props.isReady || !shouldHandleNewNoteShortcut(event)) {
          return
        }

        startCreation('file', props.currentPath === null ? null : getParentPath(props.currentPath))
      },
      {
        preventDefault: false,
        stopPropagation: false,
      },
    )

    document.addEventListener('keydown', handleNewNoteHotkey, true)

    onCleanup(() => {
      document.removeEventListener('keydown', handleNewNoteHotkey, true)
    })
  }

  onCleanup(() => {
    clearSuppressedTreeClick()
    stopPointerDrag()
    clearHoverOpenTimer()
  })

  async function submitPendingCreation(name: string, submitSource: EntryEditorSubmitSource): Promise<string | null> {
    const nextCreation = pendingCreation()

    if (nextCreation === null) {
      return null
    }

    if (nextCreation.kind === 'file') {
      return props.onCreateNote(nextCreation.parentPath, name, submitSource)
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
      <div
        classList={{
          'sidebar-dragging': draggedEntry() !== null,
          'sidebar-tree-dropzone': true,
          'sidebar-tree-dropzone-root-target': dropTarget()?.kind === 'root',
        }}
        data-tree-root-dropzone="true"
        onDragOver={(event) => {
          if (draggedEntry() === null) {
            return
          }

          const target = event.target

          if (target instanceof Element && target.closest('[data-tree-directory-drop-path]') !== null) {
            return
          }

          event.preventDefault()

          const dataTransfer = event.dataTransfer ?? null

          if (dataTransfer !== null) {
            dataTransfer.dropEffect = 'move'
          }

          setMoveDropTarget({ kind: 'root' })
        }}
        onDragLeave={(event) => {
          if (draggedEntry() === null) {
            return
          }

          const nextTarget = event.relatedTarget

          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return
          }

          setMoveDropTarget(null)
        }}
        onDrop={(event) => {
          const entry = draggedEntry()

          if (entry === null) {
            return
          }

          const target = event.target

          if (target instanceof Element && target.closest('[data-tree-directory-drop-path]') !== null) {
            return
          }

          event.preventDefault()
          clearDragState()
          void moveEntry(entry, null)
        }}
      >
        <Show when={props.nodes.length > 0 || pendingCreation()?.parentPath === null} fallback={<p>{props.emptyMessage}</p>}>
          <FileTree
            conflict={props.conflict}
            conflictPaths={props.conflictPaths}
            currentPath={props.currentPath}
            draggedEntry={draggedEntry()}
            dropTarget={dropTarget()}
            isDirectoryOpen={isDirectoryOpen}
            parentPath={null}
            nodes={props.nodes}
            onSetDirectoryOpen={setDirectoryOpen}
            unsavedPath={props.unsavedPath}
            onAcceptTheirs={props.onAcceptTheirs}
            canDropInDirectory={(path) => {
              const entry = draggedEntry()

              return entry !== null && canDropInDirectory(entry, path)
            }}
            pendingCreation={pendingCreation()}
            pendingRename={pendingRename()}
            onCancelAction={clearPendingAction}
            onClearMoveDropTarget={() => {
              setMoveDropTarget(null)
            }}
            onCreateFolder={(path) => {
              startCreation('directory', path)
            }}
            onCreateNote={(path) => {
              startCreation('file', path)
            }}
            onDelete={props.onDeleteEntry}
            onDragOverDirectory={(path) => {
              setMoveDropTarget({ kind: 'directory', path })
            }}
            onDropDirectory={(path) => {
              const entry = draggedEntry()

              if (entry === null || !canDropInDirectory(entry, path)) {
                return
              }

              clearDragState()
              void moveEntry(entry, path)
            }}
            onEndDrag={clearDragState}
            onOpen={props.onOpen}
            onOpenConflict={props.onOpenConflict}
            onResolveInDiff={props.onResolveInDiff}
            onSaveMine={props.onSaveMine}
            onSaveMineSeparately={props.onSaveMineSeparately}
            onStartPointerDrag={(entry, pointerId, clientX, clientY) => {
              stopPointerDrag()
              pointerDrag = {
                clientX,
                clientY,
                entry,
                pointerId,
                started: false,
              }
              document.addEventListener('pointermove', handlePointerMove, true)
              document.addEventListener('pointerup', handlePointerUp, true)
              document.addEventListener('pointercancel', handlePointerCancel, true)
            }}
            onStartDrag={(entry) => {
              setDraggedEntry(entry)
              setMoveDropTarget(null)
            }}
            onStartRename={startRename}
            onSubmitCreation={submitPendingCreation}
            onSubmitRename={submitPendingRename}
          />
        </Show>
      </div>
      <Show when={draggedEntry() !== null && dragPreviewPosition() !== null}>
        <div
          class="sidebar-drag-preview"
          aria-hidden="true"
          style={{
            left: `${dragPreviewPosition()!.x + 14}px`,
            top: `${dragPreviewPosition()!.y + 14}px`,
          }}
        >
          <Codicon name={draggedEntry()!.kind === 'directory' ? 'folder' : 'file'} />
          <span>{getName(draggedEntry()!.path)}</span>
        </div>
      </Show>
    </aside>
  )
}
