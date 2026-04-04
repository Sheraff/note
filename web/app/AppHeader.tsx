import { createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import './AppHeader.css'
import { Codicon } from './Codicon.tsx'

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
  style: 'short',
})

const absoluteTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const relativeTimeUnits: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
  ['second', 1000],
]

function formatRelativeSyncTime(timestamp: string, now: number): string | null {
  const syncedAt = new Date(timestamp)
  const syncedAtTime = syncedAt.getTime()

  if (Number.isNaN(syncedAtTime)) {
    return null
  }

  const elapsed = Math.max(0, now - syncedAtTime)

  if (elapsed < 30_000) {
    return relativeTimeFormat.format(0, 'second')
  }

  for (const [unit, unitSize] of relativeTimeUnits) {
    if (elapsed >= unitSize) {
      return relativeTimeFormat.format(-Math.round(elapsed / unitSize), unit)
    }
  }

  return relativeTimeFormat.format(-Math.round(elapsed / 1000), 'second')
}

function formatAbsoluteSyncTime(timestamp: string): string | null {
  const syncedAt = new Date(timestamp)

  if (Number.isNaN(syncedAt.getTime())) {
    return null
  }

  return absoluteTimeFormat.format(syncedAt)
}

export function AppHeader(props: {
  isSyncing: boolean
  isOpfsActive: boolean
  lastSyncedAt: string | null
  statusMessage: string
  storageLabel: string
  onAttachFolder(): void
  onSync(): void
  onSwitchToOpfs(): void
}) {
  const storagePopoverId = 'storage-menu'
  let syncLabelInterval: number | undefined

  const [now, setNow] = createSignal(Date.now())
  const syncLabel = createMemo(() => {
    if (props.isSyncing) {
      return 'Syncing...'
    }

    if (props.lastSyncedAt === null) {
      return 'Sync'
    }

    const relativeTime = formatRelativeSyncTime(props.lastSyncedAt, now())
    return relativeTime === null ? 'Sync' : `Sync: ${relativeTime}`
  })
  const syncTitle = createMemo(() => {
    if (props.lastSyncedAt === null) {
      return undefined
    }

    return formatAbsoluteSyncTime(props.lastSyncedAt) ?? undefined
  })

  onMount(() => {
    syncLabelInterval = window.setInterval(() => {
      setNow(Date.now())
    }, 30_000)
  })

  onCleanup(() => {
    if (syncLabelInterval !== undefined) {
      window.clearInterval(syncLabelInterval)
    }
  })

  return (
    <header class="topbar">
      <div>
        <h1>Note</h1>
        <p>{props.statusMessage}</p>
      </div>
      <div class="actions">
        <div class="storage-menu">
          <button type="button" class="storage-menu-trigger" popovertarget={storagePopoverId}>
            <Codicon name="database" />
            <span class="storage-menu-label">Storage: {props.storageLabel}</span>
            <Codicon name="chevron-down" />
          </button>
          <div id={storagePopoverId} class="storage-menu-popover" popover="auto">
            <button
              type="button"
              popovertarget={storagePopoverId}
              popovertargetaction="hide"
              onClick={props.onAttachFolder}
            >
              <Codicon name="folder-library" />
              Attach folder
            </button>
            <button
              type="button"
              disabled={props.isOpfsActive}
              popovertarget={storagePopoverId}
              popovertargetaction="hide"
              onClick={props.onSwitchToOpfs}
            >
              <Codicon name="database" />
              Use OPFS
            </button>
          </div>
        </div>
        <button
          type="button"
          class="sync-button"
          onClick={props.onSync}
          disabled={props.isSyncing}
          aria-busy={props.isSyncing}
          title={syncTitle()}
        >
          <Codicon name="refresh" />
          <span>{syncLabel()}</span>
        </button>
      </div>
    </header>
  )
}
