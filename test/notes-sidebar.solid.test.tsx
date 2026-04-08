import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotesSidebar } from '../web/app/NotesSidebar.tsx'
import { buildTree, type ListedEntry } from '../web/notes/tree.ts'

type NotesSidebarProps = Parameters<typeof NotesSidebar>[0]

const conflictLabels = {
  acceptTheirs: 'Accept file version',
  resolveInDiff: 'Resolve conflicting changes',
  saveMine: 'Save my current draft',
  saveMineSeparately: 'Save my current draft separately',
}

function renderSidebar(
  overrides: Partial<NotesSidebarProps> = {},
  entries: ListedEntry[] = [],
) {
  const props: NotesSidebarProps = {
    conflict: null,
    conflictPaths: [],
    currentPath: null,
    emptyMessage: 'Attach a folder to reopen your notes.',
    fileCount: entries.filter((entry) => entry.kind === 'file').length,
    isReady: true,
    nodes: buildTree(entries),
    unsavedPath: null,
    onAcceptTheirs: vi.fn(),
    onCreateFolder: vi.fn(async () => null),
    onCreateNote: vi.fn(async () => null),
    onDeleteEntry: vi.fn(),
    onMoveEntry: vi.fn(async () => true),
    onOpen: vi.fn(),
    onOpenConflict: vi.fn(),
    onRenameEntry: vi.fn(async () => null),
    onResolveInDiff: vi.fn(),
    onSaveMine: vi.fn(),
    onSaveMineSeparately: vi.fn(),
    ...overrides,
  }

  render(() => <NotesSidebar {...props} />)

  return { props }
}

function getButtonByText(text: string): HTMLButtonElement {
  const button = screen.getByText(text).closest('button')

  if (button === null) {
    throw new Error(`Expected a button for text: ${text}`)
  }

  return button as HTMLButtonElement
}

function getTextbox(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('NotesSidebar', () => {
  it('shows the empty message when there are no nodes and no pending root creation', () => {
    renderSidebar()

    expect(screen.getByText('Attach a folder to reopen your notes.').textContent).toBe(
      'Attach a folder to reopen your notes.',
    )
  })

  it('shows a root note editor row after clicking New note in the header', () => {
    renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))

    expect(screen.queryByText('Attach a folder to reopen your notes.')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('untitled.md')
  })

  it('shows a root folder editor row after clicking New folder in the header', () => {
    renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))

    expect(screen.queryByText('Attach a folder to reopen your notes.')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('untitled')
  })

  it('disables both header create buttons when the sidebar is not ready', () => {
    renderSidebar({
      isReady: false,
    })

    expect((screen.getByRole('button', { name: 'New note' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'New folder' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables both header create buttons when the sidebar is ready', () => {
    renderSidebar({
      isReady: true,
    })

    expect((screen.getByRole('button', { name: 'New note' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'New folder' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the file count in the sidebar heading', () => {
    renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
        { kind: 'file', path: 'notes/tomorrow.md' },
      ],
    )

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Notes2')
  })

  it('opens a normal file row through onOpen', () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'today.md' }))

    expect(props.onOpen).toHaveBeenCalledWith('notes/today.md')
    expect(props.onOpenConflict).not.toHaveBeenCalled()
  })

  it('opens a conflicted file row through onOpenConflict', () => {
    const { props } = renderSidebar(
      {
        conflict: {
          labels: conflictLabels,
          path: 'notes/today.md',
        },
      },
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'today.md' }))

    expect(props.onOpenConflict).toHaveBeenCalledWith('notes/today.md')
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('marks the current file row with aria-current', () => {
    renderSidebar(
      {
        currentPath: 'notes/today.md',
      },
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    expect(screen.getByRole('button', { name: 'today.md' }).getAttribute('aria-current')).toBe('true')
  })

  it('shows the unsaved indicator only on the current unsaved file row', () => {
    renderSidebar(
      {
        currentPath: 'notes/today.md',
        unsavedPath: 'notes/today.md',
      },
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
        { kind: 'file', path: 'notes/tomorrow.md' },
      ],
    )

    const unsavedButton = screen.getByRole('button', { name: 'today.md' })
    const savedButton = screen.getByRole('button', { name: 'tomorrow.md' })

    expect(unsavedButton.className).toContain('tree-entry-unsaved')
    expect(unsavedButton.querySelector('.tree-entry-unsaved-indicator')).not.toBeNull()
    expect(savedButton.className).not.toContain('tree-entry-unsaved')
    expect(savedButton.querySelector('.tree-entry-unsaved-indicator')).toBeNull()
  })

  it('does not show the unsaved indicator when the current file is saved', () => {
    renderSidebar(
      {
        currentPath: 'notes/today.md',
        unsavedPath: null,
      },
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    const noteButton = screen.getByRole('button', { name: 'today.md' })

    expect(noteButton.className).not.toContain('tree-entry-unsaved')
    expect(noteButton.querySelector('.tree-entry-unsaved-indicator')).toBeNull()
  })

  it('toggles a folder row closed and open again when clicked repeatedly', () => {
    renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    const folderButton = screen.getByRole('button', { name: 'notes' })

    expect(screen.getByRole('button', { name: 'today.md' })).toBeTruthy()

    fireEvent.click(folderButton)

    expect(screen.queryByRole('button', { name: 'today.md' })).toBeNull()

    fireEvent.click(folderButton)

    expect(screen.getByRole('button', { name: 'today.md' })).toBeTruthy()
  })

  it('marks a closed folder when a descendant note path is conflicted', () => {
    renderSidebar(
      {
        conflictPaths: ['notes/today.md'],
      },
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    const folderButton = screen.getByRole('button', { name: 'notes' })

    fireEvent.click(folderButton)

    expect(folderButton.className).toContain('tree-entry-descendant-conflict')
    expect(screen.queryByRole('button', { name: 'today.md' })).toBeNull()
  })

  it('starts nested note creation from a folder action button', () => {
    renderSidebar(
      {},
      [{ kind: 'directory', path: 'notes' }],
    )

    fireEvent.click(screen.getByRole('button', { name: 'New note in notes' }))

    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('untitled.md')
  })

  it('starts nested folder creation from a folder action button', () => {
    renderSidebar(
      {},
      [{ kind: 'directory', path: 'notes' }],
    )

    fireEvent.click(screen.getByRole('button', { name: 'New folder in notes' }))

    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('untitled')
  })

  it('wires the file delete action to onDeleteEntry', () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete notes/today.md' }))

    expect(props.onDeleteEntry).toHaveBeenCalledWith('notes/today.md', 'file')
  })

  it('wires the folder delete action to onDeleteEntry', () => {
    const { props } = renderSidebar(
      {},
      [{ kind: 'directory', path: 'notes' }],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete folder notes' }))

    expect(props.onDeleteEntry).toHaveBeenCalledWith('notes', 'directory')
  })

  it('moves a dragged file into a folder through onMoveEntry', async () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
        { kind: 'directory', path: 'archive' },
      ],
    )

    fireEvent.dragStart(screen.getByRole('button', { name: 'today.md' }))
    fireEvent.dragOver(screen.getByRole('button', { name: 'archive' }))
    fireEvent.drop(screen.getByRole('button', { name: 'archive' }))

    await waitFor(() => {
      expect(props.onMoveEntry).toHaveBeenCalledWith({ kind: 'file', path: 'notes/today.md' }, 'archive')
    })
  })

  it('moves a dragged folder into another folder through onMoveEntry', async () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'projects' },
        { kind: 'directory', path: 'archive' },
        { kind: 'directory', path: 'archive/keep' },
      ],
    )

    fireEvent.dragStart(screen.getByRole('button', { name: 'projects' }))
    fireEvent.dragOver(screen.getByRole('button', { name: 'archive' }))
    fireEvent.drop(screen.getByRole('button', { name: 'archive' }))

    await waitFor(() => {
      expect(props.onMoveEntry).toHaveBeenCalledWith({ kind: 'directory', path: 'projects' }, 'archive')
    })
  })

  it('moves a dragged file to the root when dropped on empty sidebar space', async () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    const dropzone = document.querySelector('.sidebar-tree-dropzone')

    if (!(dropzone instanceof HTMLDivElement)) {
      throw new Error('Expected a root dropzone element')
    }

    fireEvent.dragStart(screen.getByRole('button', { name: 'today.md' }))
    fireEvent.dragOver(dropzone)
    fireEvent.drop(dropzone)

    await waitFor(() => {
      expect(props.onMoveEntry).toHaveBeenCalledWith({ kind: 'file', path: 'notes/today.md' }, null)
    })
  })

  it('moves a dragged folder to the root when dropped on empty sidebar space', async () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'projects' },
        { kind: 'directory', path: 'projects/source' },
      ],
    )

    const dropzone = document.querySelector('.sidebar-tree-dropzone')

    if (!(dropzone instanceof HTMLDivElement)) {
      throw new Error('Expected a root dropzone element')
    }

    fireEvent.dragStart(screen.getByRole('button', { name: 'source' }))
    fireEvent.dragOver(dropzone)
    fireEvent.drop(dropzone)

    await waitFor(() => {
      expect(props.onMoveEntry).toHaveBeenCalledWith({ kind: 'directory', path: 'projects/source' }, null)
    })
  })

  it('opens a hovered closed folder after one second during drag', async () => {
    vi.useFakeTimers()

    renderSidebar(
      {},
      [
        { kind: 'directory', path: 'projects' },
        { kind: 'file', path: 'projects/today.md' },
        { kind: 'directory', path: 'projects/archive' },
        { kind: 'file', path: 'projects/archive/inside.md' },
      ],
    )

    expect(screen.queryByRole('button', { name: 'inside.md' })).toBeNull()

    fireEvent.dragStart(screen.getByRole('button', { name: 'today.md' }))
    fireEvent.dragOver(screen.getByRole('button', { name: 'archive' }))
    await vi.advanceTimersByTimeAsync(1000)

    expect(screen.getByRole('button', { name: 'inside.md' })).toBeTruthy()
  })

  it('resets the folder hover-open delay after leaving for an already-open folder', async () => {
    vi.useFakeTimers()

    renderSidebar(
      {},
      [
        { kind: 'directory', path: 'projects' },
        { kind: 'file', path: 'projects/today.md' },
        { kind: 'directory', path: 'projects/archive' },
        { kind: 'file', path: 'projects/archive/inside.md' },
        { kind: 'directory', path: 'inbox' },
      ],
    )

    expect(screen.queryByRole('button', { name: 'inside.md' })).toBeNull()

    fireEvent.dragStart(screen.getByRole('button', { name: 'today.md' }))
    fireEvent.dragOver(screen.getByRole('button', { name: 'archive' }))
    await vi.advanceTimersByTimeAsync(500)
    fireEvent.dragOver(screen.getByRole('button', { name: 'inbox' }))
    await vi.advanceTimersByTimeAsync(600)

    expect(screen.queryByRole('button', { name: 'inside.md' })).toBeNull()
  })

  it('does not move a dragged folder into itself', async () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'projects' },
        { kind: 'directory', path: 'projects/archive' },
      ],
    )

    const folderButton = screen.getByRole('button', { name: 'projects' })

    fireEvent.dragStart(folderButton)
    fireEvent.dragOver(folderButton)
    fireEvent.drop(folderButton)

    await waitFor(() => {
      expect(props.onMoveEntry).not.toHaveBeenCalled()
    })
  })

  it('does not hover-open or move a descendant folder while dragging its ancestor', async () => {
    vi.useFakeTimers()

    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'projects' },
        { kind: 'directory', path: 'projects/archive' },
        { kind: 'file', path: 'projects/archive/inside.md' },
      ],
    )

    expect(screen.queryByRole('button', { name: 'inside.md' })).toBeNull()

    fireEvent.dragStart(screen.getByRole('button', { name: 'projects' }))
    fireEvent.dragOver(screen.getByRole('button', { name: 'archive' }))
    await vi.advanceTimersByTimeAsync(1000)
    fireEvent.drop(screen.getByRole('button', { name: 'archive' }))

    expect(screen.queryByRole('button', { name: 'inside.md' })).toBeNull()
    expect(props.onMoveEntry).not.toHaveBeenCalled()
  })

  it('keeps a moved folder closed when its path changes', async () => {
    const initialEntries: ListedEntry[] = [
      { kind: 'directory', path: 'projects' },
      { kind: 'directory', path: 'projects/source' },
      { kind: 'file', path: 'projects/source/today.md' },
    ]
    const movedEntries: ListedEntry[] = [
      { kind: 'directory', path: 'source' },
      { kind: 'file', path: 'source/today.md' },
    ]
    const [nodes, setNodes] = createSignal(buildTree(initialEntries))
    const [currentPath, setCurrentPath] = createSignal<string | null>('projects/source/today.md')
    const onMoveEntry = vi.fn(async () => {
      setNodes(buildTree(movedEntries))
      setCurrentPath('source/today.md')
      return true
    })

    render(() => (
      <NotesSidebar
        conflict={null}
        conflictPaths={[]}
        currentPath={currentPath()}
        emptyMessage="Attach a folder to reopen your notes."
        fileCount={1}
        isReady={true}
        nodes={nodes()}
        unsavedPath={null}
        onAcceptTheirs={vi.fn()}
        onCreateFolder={vi.fn(async () => null)}
        onCreateNote={vi.fn(async () => null)}
        onDeleteEntry={vi.fn()}
        onMoveEntry={onMoveEntry}
        onOpen={vi.fn()}
        onOpenConflict={vi.fn()}
        onRenameEntry={vi.fn(async () => null)}
        onResolveInDiff={vi.fn()}
        onSaveMine={vi.fn()}
        onSaveMineSeparately={vi.fn()}
      />
    ))

    const sourceButton = screen.getByRole('button', { name: 'source' })
    const dropzone = document.querySelector('.sidebar-tree-dropzone')

    if (!(dropzone instanceof HTMLDivElement)) {
      throw new Error('Expected a root dropzone element')
    }

    fireEvent.click(sourceButton)
    expect(sourceButton.getAttribute('aria-expanded')).toBe('false')

    fireEvent.dragStart(sourceButton)
    fireEvent.dragOver(dropzone)
    fireEvent.drop(dropzone)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'source' }).getAttribute('aria-expanded')).toBe('false')
    })
  })

  it('wires the tree conflict actions to the conflict callbacks', () => {
    const { props } = renderSidebar(
      {
        conflict: {
          labels: conflictLabels,
          path: 'notes/today.md',
        },
      },
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(getButtonByText(conflictLabels.saveMine))
    fireEvent.click(getButtonByText(conflictLabels.acceptTheirs))
    fireEvent.click(getButtonByText(conflictLabels.saveMineSeparately))
    fireEvent.click(getButtonByText(conflictLabels.resolveInDiff))

    expect(props.onSaveMine).toHaveBeenCalledTimes(1)
    expect(props.onAcceptTheirs).toHaveBeenCalledTimes(1)
    expect(props.onSaveMineSeparately).toHaveBeenCalledTimes(1)
    expect(props.onResolveInDiff).toHaveBeenCalledTimes(1)
  })

  it('submits root note creation on Enter', async () => {
    const { props } = renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.input(getTextbox(), { target: { value: 'journal.md' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(props.onCreateNote).toHaveBeenCalledWith(null, 'journal.md', 'enter')
    })
  })

  it('submits root folder creation on Enter', async () => {
    const { props } = renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.input(getTextbox(), { target: { value: 'archive' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(props.onCreateFolder).toHaveBeenCalledWith(null, 'archive')
    })
  })

  it('submits nested note creation on Enter', async () => {
    const { props } = renderSidebar(
      {},
      [{ kind: 'directory', path: 'notes' }],
    )

    fireEvent.click(screen.getByRole('button', { name: 'New note in notes' }))
    fireEvent.input(getTextbox(), { target: { value: 'journal.md' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(props.onCreateNote).toHaveBeenCalledWith('notes', 'journal.md', 'enter')
    })
  })

  it('submits nested folder creation on Enter', async () => {
    const { props } = renderSidebar(
      {},
      [{ kind: 'directory', path: 'notes' }],
    )

    fireEvent.click(screen.getByRole('button', { name: 'New folder in notes' }))
    fireEvent.input(getTextbox(), { target: { value: 'archive' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(props.onCreateFolder).toHaveBeenCalledWith('notes', 'archive')
    })
  })

  it('submits a non-empty create action on blur', async () => {
    const { props } = renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.input(getTextbox(), { target: { value: 'journal.md' } })
    fireEvent.blur(getTextbox())

    await waitFor(() => {
      expect(props.onCreateNote).toHaveBeenCalledWith(null, 'journal.md', 'blur')
    })
  })

  it('cancels create on Escape without calling the create handler', () => {
    const { props } = renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.keyDown(getTextbox(), { key: 'Escape' })

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(props.onCreateNote).not.toHaveBeenCalled()
  })

  it('cancels create for a blank name without calling the create handler', () => {
    const { props } = renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.input(getTextbox(), { target: { value: '   ' } })
    fireEvent.blur(getTextbox())

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(props.onCreateNote).not.toHaveBeenCalled()
  })

  it('shows an inline create error and keeps the editor row open when creation fails', async () => {
    renderSidebar({
      onCreateNote: vi.fn(async () => 'A note with that name already exists.'),
    })

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.input(getTextbox(), { target: { value: 'journal.md' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('A note with that name already exists.')
    })

    expect(getTextbox().value).toBe('journal.md')
  })

  it('clears the inline create error after typing again', async () => {
    renderSidebar({
      onCreateNote: vi.fn(async () => 'A note with that name already exists.'),
    })

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.input(getTextbox(), { target: { value: 'journal.md' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })

    fireEvent.input(getTextbox(), { target: { value: 'journal-2.md' } })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes the create editor after a successful create', async () => {
    renderSidebar({
      onCreateNote: vi.fn(async () => null),
    })

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.input(getTextbox(), { target: { value: 'journal.md' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull()
    })
  })

  it('reopens a closed folder when starting nested creation inside it', () => {
    renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'notes' }))

    expect(screen.queryByRole('button', { name: 'today.md' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New note in notes' }))

    expect(getTextbox().value).toBe('untitled.md')
    expect(screen.getByRole('button', { name: 'today.md' })).toBeTruthy()
  })

  it('opens an inline editor with the current file name from the file rename action', () => {
    renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename notes/today.md' }))

    expect(getTextbox().value).toBe('today.md')
  })

  it('opens an inline editor with the current folder name from the folder rename action', () => {
    renderSidebar(
      {},
      [{ kind: 'directory', path: 'notes' }],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename folder notes' }))

    expect(getTextbox().value).toBe('notes')
  })

  it('submits rename through onRenameEntry', async () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename notes/today.md' }))
    fireEvent.input(getTextbox(), { target: { value: 'done.md' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(props.onRenameEntry).toHaveBeenCalledWith('notes/today.md', 'file', 'done.md')
    })
  })

  it('submits a non-empty rename on blur', async () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename notes/today.md' }))
    fireEvent.input(getTextbox(), { target: { value: 'done.md' } })
    fireEvent.blur(getTextbox())

    await waitFor(() => {
      expect(props.onRenameEntry).toHaveBeenCalledWith('notes/today.md', 'file', 'done.md')
    })
  })

  it('cancels rename on Escape without calling the rename handler', () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename notes/today.md' }))
    fireEvent.keyDown(getTextbox(), { key: 'Escape' })

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(props.onRenameEntry).not.toHaveBeenCalled()
  })

  it('cancels rename for a blank name without calling the rename handler', () => {
    const { props } = renderSidebar(
      {},
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename notes/today.md' }))
    fireEvent.input(getTextbox(), { target: { value: '   ' } })
    fireEvent.blur(getTextbox())

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(props.onRenameEntry).not.toHaveBeenCalled()
  })

  it('shows an inline rename error and keeps the editor row open when rename fails', async () => {
    renderSidebar(
      {
        onRenameEntry: vi.fn(async () => 'An entry named "done.md" already exists here.'),
      },
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename notes/today.md' }))
    fireEvent.input(getTextbox(), { target: { value: 'done.md' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('An entry named "done.md" already exists here.')
    })

    expect(getTextbox().value).toBe('done.md')
  })

  it('clears the inline rename error after typing again', async () => {
    renderSidebar(
      {
        onRenameEntry: vi.fn(async () => 'An entry named "done.md" already exists here.'),
      },
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename notes/today.md' }))
    fireEvent.input(getTextbox(), { target: { value: 'done.md' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })

    fireEvent.input(getTextbox(), { target: { value: 'done-2.md' } })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes the rename editor after a successful rename', async () => {
    renderSidebar(
      {
        onRenameEntry: vi.fn(async () => null),
      },
      [
        { kind: 'directory', path: 'notes' },
        { kind: 'file', path: 'notes/today.md' },
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename notes/today.md' }))
    fireEvent.input(getTextbox(), { target: { value: 'done.md' } })
    fireEvent.keyDown(getTextbox(), { key: 'Enter' })

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull()
    })
  })
})
