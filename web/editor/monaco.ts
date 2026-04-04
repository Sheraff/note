import * as monaco from 'monaco-editor'
// import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
// import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

// self.MonacoEnvironment = {
//   getWorker() {
//     return new EditorWorker()
//   },
// }

export type MonacoController = {
  getValue(): string
  setValue(value: string): void
  focus(): void
  dispose(): void
}

export function createMonacoEditor(
  element: HTMLElement,
  options: {
    initialValue: string
    onChange(value: string): void
    onSave(): void
  },
): MonacoController {
  let isApplyingValue = false

  const editor = monaco.editor.create(element, {
    value: options.initialValue,
    language: 'markdown',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: 'on',
    lineNumbers: 'on',
    padding: { top: 20 },
    tabSize: 2,
    insertSpaces: true,
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    options.onSave()
  })

  editor.onDidChangeModelContent(() => {
    if (isApplyingValue) {
      return
    }

    options.onChange(editor.getValue())
  })

  return {
    getValue() {
      return editor.getValue()
    },
    setValue(value) {
      if (editor.getValue() === value) {
        return
      }

      isApplyingValue = true
      editor.setValue(value)
      isApplyingValue = false
    },
    focus() {
      editor.focus()
    },
    dispose() {
      editor.dispose()
    },
  }
}
