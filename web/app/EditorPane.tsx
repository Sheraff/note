import { Show } from 'solid-js'
import { Codicon } from './Codicon.tsx'
import './EditorPane.css'

export function EditorPane(props: {
  currentPath: string | null
  reconnectableDirectoryName: string | null
  onAttachFolder(): void
  onEditorMount(element: HTMLDivElement): void
  onReconnectFolder(): void
  onSwitchToOpfs(): void
}) {
  const reconnectLabel = () =>
    props.reconnectableDirectoryName === null ? null : `Reconnect ${props.reconnectableDirectoryName}`

  return (
    <section class="editor">
      <div class="stage">
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
