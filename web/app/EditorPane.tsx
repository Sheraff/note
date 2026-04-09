import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { Codicon } from './Codicon.tsx'
import type { StoredFile, StoredFileViewKind } from '../storage/types.ts'
import './EditorPane.css'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function EditorPane(props: {
  currentPath: string | null
  currentFile: StoredFile | null
  fileViewKind: StoredFileViewKind | null
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
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null)
  const reconnectLabel = () =>
    props.reconnectableDirectoryName === null ? null : `Reconnect ${props.reconnectableDirectoryName}`

  // TODO: we shouldn't need an effect, this is not react, just make a sub component
  // for when we need to show a preview, create the object URL inline and revoke it on cleanup
  createEffect(() => {
    const file = props.currentFile

    if (props.fileViewKind !== 'image' || file === null || file.format !== 'binary') {
      setPreviewUrl(null)
      return
    }

    const objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(file.content)], { type: file.mimeType ?? undefined }))

    setPreviewUrl(objectUrl)
    onCleanup(() => {
      URL.revokeObjectURL(objectUrl)
    })
  })

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
        <Show when={props.currentFile !== null && props.fileViewKind !== null && props.fileViewKind !== 'text'}>
          <div class="editor-preview">
            <Show
              when={props.fileViewKind === 'image' && previewUrl() !== null}
              fallback={
                <section class="editor-attachment-panel">
                  <Codicon name="file" />
                  <h2>{props.currentPath}</h2>
                  <p>This file cannot be edited in Monaco.</p>
                  <dl class="editor-attachment-meta">
                    <div>
                      <dt>Type</dt>
                      <dd>{props.currentFile?.mimeType ?? 'Unknown'}</dd>
                    </div>
                    <div>
                      <dt>Size</dt>
                      <dd>{props.currentFile?.size == null ? 'Unknown' : formatFileSize(props.currentFile.size)}</dd>
                    </div>
                  </dl>
                </section>
              }
            >
              <section class="editor-image-preview-panel">
                <div class="editor-image-preview-meta">
                  <strong>{props.currentPath}</strong>
                  <span>
                    {props.currentFile?.mimeType ?? 'Image'} ·{' '}
                    {props.currentFile?.size == null ? 'Unknown size' : formatFileSize(props.currentFile.size)}
                  </span>
                </div>
                <img src={previewUrl() ?? undefined} alt={props.currentPath ?? 'Image preview'} />
              </section>
            </Show>
          </div>
        </Show>
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
