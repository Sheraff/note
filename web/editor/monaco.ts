import * as monaco from 'monaco-editor'
// import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import './monaco-font.css'

const MONASPACE_FONT_FAMILY = 'Monaspace Neon'
const MONASPACE_FONT_LIGATURES =
  "'calt', 'liga', 'ss01', 'ss02', 'ss03', 'ss04', 'ss05', 'ss06', 'ss07', 'ss08', 'ss09', 'cv01' 4, 'cv31' 0"

let monaspaceFontReady: Promise<void> | undefined

function ensureMonaspaceFont(): Promise<void> {
  if (monaspaceFontReady !== undefined) {
    return monaspaceFontReady
  }

  if (typeof document === 'undefined' || !('fonts' in document)) {
    monaspaceFontReady = Promise.resolve()
    return monaspaceFontReady
  }

  monaspaceFontReady = document.fonts.load(`300 12px "${MONASPACE_FONT_FAMILY}"`).then(
    () => undefined,
    () => undefined,
  )

  return monaspaceFontReady
}

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker()
  },
}

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

  void ensureMonaspaceFont()

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
    fontFamily: MONASPACE_FONT_FAMILY,
    fontWeight: '300',
    fontSize: 14,
    lineHeight: 1.6,
    fontLigatures: MONASPACE_FONT_LIGATURES,
    fontVariations: true,
  })

  void ensureMonaspaceFont().then(() => {
    monaco.editor.remeasureFonts()
    editor.layout()
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
