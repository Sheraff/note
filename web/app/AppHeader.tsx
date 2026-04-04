import './AppHeader.css'
import { Codicon } from './Codicon.tsx'

export function AppHeader(props: {
  canDelete: boolean
  isSyncing: boolean
  isOpfsActive: boolean
  statusMessage: string
  storageLabel: string
  syncLabel: string
  onAttachFolder(): void
  onCreateFolder(): void
  onCreateNote(): void
  onDeleteNote(): void
  onSync(): void
  onSwitchToOpfs(): void
}) {
  return (
    <header class="topbar">
      <div>
        <h1>Note</h1>
        <p>{props.statusMessage}</p>
      </div>
      <div class="actions">
        <span class="pill">
          <Codicon name="database" />
          Storage: {props.storageLabel}
        </span>
        <span class="pill">
          <Codicon name="history" />
          {props.syncLabel}
        </span>
        <button type="button" onClick={props.onCreateNote}>
          <Codicon name="new-file" />
          New note
        </button>
        <button type="button" onClick={props.onCreateFolder}>
          <Codicon name="new-folder" />
          New folder
        </button>
        <button type="button" onClick={props.onDeleteNote} disabled={!props.canDelete}>
          <Codicon name="trash" />
          Delete note
        </button>
        <button type="button" onClick={props.onAttachFolder}>
          <Codicon name="folder-library" />
          Attach folder
        </button>
        <button type="button" onClick={props.onSwitchToOpfs} disabled={props.isOpfsActive}>
          <Codicon name="database" />
          Use OPFS
        </button>
        <button type="button" onClick={props.onSync} disabled={props.isSyncing} aria-busy={props.isSyncing}>
          <Codicon name="refresh" />
          {props.isSyncing ? 'Syncing...' : 'Sync'}
        </button>
      </div>
    </header>
  )
}
