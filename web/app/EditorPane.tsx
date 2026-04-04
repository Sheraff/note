import { Show } from 'solid-js'
import './EditorPane.css'

export function EditorPane(props: {
  currentPath: string | null
  isSaving: boolean
  onEditorMount(element: HTMLDivElement): void
}) {
  return (
    <section class="editor">
      <header>
        <h2>{props.currentPath ?? 'No note selected'}</h2>
        <p>{props.isSaving ? 'Saving...' : 'Autosave enabled. Press Ctrl/Cmd+S to save now.'}</p>
      </header>
      <div class="stage">
        <div class="surface" ref={props.onEditorMount} />
        <Show when={props.currentPath === null}>
          <div class="empty">Select a note from the sidebar or create one.</div>
        </Show>
      </div>
    </section>
  )
}
