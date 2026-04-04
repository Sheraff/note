import { Show } from 'solid-js'
import './EditorPane.css'

export function EditorPane(props: {
  currentPath: string | null
  onEditorMount(element: HTMLDivElement): void
}) {
  return (
    <section class="editor">
      <div class="stage">
        <div class="surface" ref={props.onEditorMount} />
        <Show when={props.currentPath === null}>
          <div class="empty">Select a note from the sidebar or create one.</div>
        </Show>
      </div>
    </section>
  )
}
