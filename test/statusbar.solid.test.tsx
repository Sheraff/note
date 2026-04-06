import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusBar } from '../web/app/StatusBar.tsx'

type StatusBarProps = Parameters<typeof StatusBar>[0]

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
  style: 'short',
})

const absoluteTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const conflictLabels = {
  acceptTheirs: 'Accept file version',
  resolveInDiff: 'Resolve conflicting changes',
  saveMine: 'Save my current draft',
  saveMineSeparately: 'Save my current draft separately',
}

function renderStatusBar(overrides: Partial<StatusBarProps> = {}) {
  const props: StatusBarProps = {
    canReconnectFolder: false,
    canSync: true,
    conflict: null,
    errorMessage: null,
    isSyncing: false,
    isOpfsActive: false,
    lastSyncedAt: null,
    reconnectLabel: null,
    storageLabel: 'OPFS',
    onAcceptTheirs: vi.fn(),
    onAttachFolder: vi.fn(),
    onReconnectFolder: vi.fn(),
    onResolveInDiff: vi.fn(),
    onSaveMine: vi.fn(),
    onSaveMineSeparately: vi.fn(),
    onSync: vi.fn(),
    onSwitchToOpfs: vi.fn(),
    ...overrides,
  }

  render(() => <StatusBar {...props} />)

  return { props }
}

function getButtonByText(text: string): HTMLButtonElement {
  const button = screen.getByText(text).closest('button')

  if (button === null) {
    throw new Error(`Expected a button for text: ${text}`)
  }

  return button as HTMLButtonElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('StatusBar', () => {
  it('renders the storage actions and wires the attach, OPFS, and sync controls', () => {
    const { props } = renderStatusBar({
      errorMessage: 'Folder access was not granted',
      storageLabel: 'Local notes',
    })

    expect(screen.getByText('Folder access was not granted').textContent).toBe('Folder access was not granted')
    expect(screen.queryByRole('button', { name: /Reconnect / })).toBeNull()
    expect(getButtonByText('Attach folder').textContent).toContain('Attach folder')
    expect(getButtonByText('Use OPFS').textContent).toContain('Use OPFS')

    fireEvent.click(getButtonByText('Attach folder'))
    fireEvent.click(getButtonByText('Use OPFS'))
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))

    expect(props.onAttachFolder).toHaveBeenCalledTimes(1)
    expect(props.onSwitchToOpfs).toHaveBeenCalledTimes(1)
    expect(props.onSync).toHaveBeenCalledTimes(1)
  })

  it('shows reconnect actions and disables the OPFS switch when OPFS is already active', () => {
    const { props } = renderStatusBar({
      canReconnectFolder: true,
      isOpfsActive: true,
      reconnectLabel: 'Work',
      storageLabel: 'Attached folder',
    })

    expect(getButtonByText('Reconnect Work').textContent).toContain('Reconnect Work')
    expect(getButtonByText('Pick another folder').textContent).toContain('Pick another folder')

    const useOpfsButton = getButtonByText('Use OPFS')
    expect(useOpfsButton.disabled).toBe(true)

    fireEvent.click(getButtonByText('Reconnect Work'))
    fireEvent.click(useOpfsButton)

    expect(props.onReconnectFolder).toHaveBeenCalledTimes(1)
    expect(props.onSwitchToOpfs).not.toHaveBeenCalled()
  })

  it('renders conflict actions instead of the error banner and wires each conflict handler', () => {
    const { props } = renderStatusBar({
      conflict: {
        labels: conflictLabels,
        message: 'File conflict: notes/today.md',
      },
      errorMessage: 'should stay hidden',
    })

    expect(screen.queryByText('should stay hidden')).toBeNull()
    expect(screen.getByRole('button', { name: 'File conflict: notes/today.md' }).textContent).toContain(
      'File conflict: notes/today.md',
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

  it('disables the sync button and marks it busy while syncing', () => {
    const { props } = renderStatusBar({
      isSyncing: true,
    })

    const syncButton = screen.getByRole('button', { name: 'Syncing...' }) as HTMLButtonElement

    expect(syncButton.disabled).toBe(true)
    expect(syncButton.getAttribute('aria-busy')).toBe('true')

    fireEvent.click(syncButton)

    expect(props.onSync).not.toHaveBeenCalled()
  })

  it('disables sync and suppresses manual sync when syncing is unavailable', () => {
    const { props } = renderStatusBar({
      canSync: false,
    })

    const syncButton = screen.getByRole('button', { name: 'Sync' }) as HTMLButtonElement

    expect(syncButton.disabled).toBe(true)

    fireEvent.click(syncButton)

    expect(props.onSync).not.toHaveBeenCalled()
  })

  it('shows a plain sync label without a tooltip before anything has synced', () => {
    renderStatusBar({
      lastSyncedAt: null,
    })

    const syncButton = screen.getByRole('button', { name: 'Sync' }) as HTMLButtonElement

    expect(syncButton.textContent).toContain('Sync')
    expect(syncButton.getAttribute('title')).toBeNull()
  })

  it('falls back to a plain sync label without a tooltip for an invalid timestamp', () => {
    renderStatusBar({
      lastSyncedAt: 'not-a-timestamp',
    })

    const syncButton = screen.getByRole('button', { name: 'Sync' }) as HTMLButtonElement

    expect(syncButton.textContent).toContain('Sync')
    expect(syncButton.getAttribute('title')).toBeNull()
  })

  it('uses the immediate relative-time label for a very recent sync', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-06T12:00:20.000Z'))

    const syncedAt = '2026-04-06T12:00:00.000Z'
    const recentLabel = `Sync: ${relativeTimeFormat.format(0, 'second')}`

    renderStatusBar({
      lastSyncedAt: syncedAt,
    })

    expect(screen.getByRole('button', { name: recentLabel }).textContent).toContain(recentLabel)
  })

  it('shows the relative sync label and updates it over time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-06T12:00:00.000Z'))

    const syncedAt = '2026-04-06T11:59:00.000Z'
    const initialLabel = `Sync: ${relativeTimeFormat.format(-1, 'minute')}`
    const updatedLabel = `Sync: ${relativeTimeFormat.format(-2, 'minute')}`

    renderStatusBar({
      lastSyncedAt: syncedAt,
    })

    expect(screen.getByRole('button', { name: initialLabel }).getAttribute('title')).toBe(
      absoluteTimeFormat.format(new Date(syncedAt)),
    )

    await vi.advanceTimersByTimeAsync(60_000)

    expect(screen.getByRole('button', { name: updatedLabel }).textContent).toContain(updatedLabel)
  })
})
