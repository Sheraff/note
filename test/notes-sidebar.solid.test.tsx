import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
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
    currentPath: null,
    emptyMessage: 'Attach a folder to reopen your notes.',
    fileCount: entries.filter((entry) => entry.kind === 'file').length,
    isReady: true,
    nodes: buildTree(entries),
    onAcceptTheirs: vi.fn(),
    onCreateFolder: vi.fn(async () => null),
    onCreateNote: vi.fn(async () => null),
    onDeleteEntry: vi.fn(),
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
      expect(props.onCreateNote).toHaveBeenCalledWith(null, 'journal.md')
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
      expect(props.onCreateNote).toHaveBeenCalledWith('notes', 'journal.md')
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
      expect(props.onCreateNote).toHaveBeenCalledWith(null, 'journal.md')
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
