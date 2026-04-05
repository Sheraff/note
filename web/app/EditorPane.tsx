import { Show } from 'solid-js'
import { Codicon } from './Codicon.tsx'
import './EditorPane.css'

export function EditorPane(props: {
  currentPath: string | null
  isDiffMode: boolean
  reconnectableDirectoryName: string | null
  onAttachFolder(): void
  onCancelConflictDiff(): void
  onEditorMount(element: HTMLDivElement): void
  onReconnectFolder(): void
  onSaveSourceVersion(): void
  onSaveResolvedAsCopy(): void
  onSaveResolvedVersion(): void
  saveSourceVersionLabel: string
  onSwitchToOpfs(): void
}) {
  const reconnectLabel = () =>
    props.reconnectableDirectoryName === null ? null : `Reconnect ${props.reconnectableDirectoryName}`

  return (
    <section class="editor">
      <div class="stage">
        <Show when={props.isDiffMode}>
          <div class="editor-diff-actions">
            <div class="editor-diff-summary">
              <strong>Resolve conflict</strong>
              <span class="editor-diff-path">{props.currentPath}</span>
            </div>
            <div class="editor-diff-action-buttons">
              <button type="button" class="editor-diff-button editor-diff-button-save-resolved" onClick={props.onSaveResolvedVersion}>
                <Codicon name="check" />
                <span>Save resolved version</span>
              </button>
              <button type="button" class="editor-diff-button editor-diff-button-save-source" onClick={props.onSaveSourceVersion}>
                <Codicon name="discard" />
                <span>{props.saveSourceVersionLabel}</span>
              </button>
              <button type="button" class="editor-diff-button" onClick={props.onSaveResolvedAsCopy}>
                <Codicon name="copy" />
                <span>Save resolved as copy</span>
              </button>
              <button type="button" class="editor-diff-button" onClick={props.onCancelConflictDiff}>
                <Codicon name="close" />
                <span>Cancel</span>
              </button>
            </div>
          </div>
        </Show>
        <div class="surface" ref={props.onEditorMount} />
        <Show when={props.currentPath === null}>
          <div class="editor-empty">
            {props.reconnectableDirectoryName === null ? (
              <p>Select a note from the sidebar or create one.</p>
            ) : (
              <section class="editor-empty-panel">
                <h2>Folder access is needed to reopen your notes.</h2>
                <p>Choose how you want to continue with {props.reconnectableDirectoryName}.</p>
                <div class="editor-empty-actions">
                  <button type="button" onClick={props.onReconnectFolder}>
                    <Codicon name="plug" />
                    <span>{reconnectLabel()}</span>
                  </button>
                  <button type="button" onClick={props.onAttachFolder}>
                    <Codicon name="folder-library" />
                    <span>Pick another folder</span>
                  </button>
                  <button type="button" onClick={props.onSwitchToOpfs}>
                    <Codicon name="database" />
                    <span>Use OPFS</span>
                  </button>
                </div>
              </section>
            )}
          </div>
        </Show>
      </div>
    </section>
  )
}
