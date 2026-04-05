import * as monaco from 'monaco-editor'
// import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import './monaco-diff.css'
import './monaco-font.css'

const MONASPACE_FONT_FAMILY = 'Monaspace Neon'
const MONASPACE_FONT_LIGATURES =
  "'calt', 'liga', 'ss01', 'ss02', 'ss03', 'ss04', 'ss05', 'ss06', 'ss07', 'ss08', 'ss09', 'cv01' 4, 'cv31' 0"
const DIFF_LABEL_INLINE_BREAKPOINT = 900
const DIFF_LABEL_TOP_PADDING = 44

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

function createEditorOptions(options: { topPadding?: number } = {}) {
  return {
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: 'on' as const,
    lineNumbers: 'on' as const,
    padding: { top: options.topPadding ?? 20 },
    tabSize: 2,
    insertSpaces: true,
    fontFamily: MONASPACE_FONT_FAMILY,
    fontWeight: '300',
    fontSize: 14,
    lineHeight: 1.6,
    fontLigatures: MONASPACE_FONT_LIGATURES,
    fontVariations: true,
  }
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
    ...createEditorOptions(),
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

export function createMonacoDiffEditor(
  element: HTMLElement,
  options: {
    originalValue: string
    modifiedValue: string
    originalLabel: string
    modifiedLabel: string
    onChange(value: string): void
    onSave(): void
  },
): MonacoController {
  let isApplyingValue = false

  void ensureMonaspaceFont()

  const originalModel = monaco.editor.createModel(options.originalValue, 'markdown')
  const modifiedModel = monaco.editor.createModel(options.modifiedValue, 'markdown')
  const editor = monaco.editor.createDiffEditor(element, {
    ...createEditorOptions({ topPadding: DIFF_LABEL_TOP_PADDING }),
    originalEditable: false,
    renderSideBySide: true,
    renderSideBySideInlineBreakpoint: DIFF_LABEL_INLINE_BREAKPOINT,
    enableSplitViewResizing: true,
    useInlineViewWhenSpaceIsLimited: true,
  })
  const modifiedEditor = editor.getModifiedEditor()

  editor.setModel({
    original: originalModel,
    modified: modifiedModel,
  })
  const labelLayer = createDiffLabelLayer(editor, {
    originalLabel: options.originalLabel,
    modifiedLabel: options.modifiedLabel,
  })

  void ensureMonaspaceFont().then(() => {
    monaco.editor.remeasureFonts()
    editor.layout()
  })

  modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    options.onSave()
  })

  modifiedModel.onDidChangeContent(() => {
    if (isApplyingValue) {
      return
    }

    options.onChange(modifiedModel.getValue())
  })

  return {
    getValue() {
      return modifiedModel.getValue()
    },
    setValue(value) {
      if (modifiedModel.getValue() === value) {
        return
      }

      isApplyingValue = true
      modifiedModel.setValue(value)
      isApplyingValue = false
    },
    focus() {
      modifiedEditor.focus()
    },
    dispose() {
      labelLayer.dispose()
      editor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
    },
  }
}

function createDiffLabelLayer(
  editor: monaco.editor.IStandaloneDiffEditor,
  options: {
    originalLabel: string
    modifiedLabel: string
  },
) {
  const domNode = document.createElement('div')
  domNode.className = 'monaco-diff-label-layer'
  domNode.setAttribute('aria-hidden', 'true')

  const originalLabelNode = createDiffLabelNode(options.originalLabel, 'original')
  const modifiedLabelNode = createDiffLabelNode(options.modifiedLabel, 'modified')
  const inlineLegendNode = createDiffInlineLegend(options.originalLabel, options.modifiedLabel)

  domNode.append(originalLabelNode, modifiedLabelNode, inlineLegendNode)

  const originalEditor = editor.getOriginalEditor()
  const modifiedEditor = editor.getModifiedEditor()
  const container = editor.getContainerDomNode()
  const subscriptions: Array<{ dispose(): void }> = [
    originalEditor.onDidLayoutChange(() => {
      layoutLabels()
    }),
    modifiedEditor.onDidLayoutChange(() => {
      layoutLabels()
    }),
  ]

  container.append(domNode)
  layoutLabels()

  return {
    dispose() {
      for (const subscription of subscriptions) {
        subscription.dispose()
      }

      domNode.remove()
    },
  }

  function layoutLabels() {
    const isInlineMode = editor.getContainerDomNode().clientWidth <= DIFF_LABEL_INLINE_BREAKPOINT

    originalLabelNode.classList.toggle('monaco-diff-label-hidden', isInlineMode)
    modifiedLabelNode.classList.toggle('monaco-diff-label-hidden', isInlineMode)
    inlineLegendNode.classList.toggle('monaco-diff-label-hidden', !isInlineMode)

    if (isInlineMode) {
      return
    }

    positionPaneLabel(originalLabelNode, originalEditor, 'left')
    positionPaneLabel(modifiedLabelNode, modifiedEditor, 'right')
  }

  function positionPaneLabel(
    labelNode: HTMLDivElement,
    paneEditor: monaco.editor.ICodeEditor,
    alignment: 'left' | 'right',
  ) {
    const containerRect = editor.getContainerDomNode().getBoundingClientRect()
    const paneDomNode = paneEditor.getDomNode()

    if (paneDomNode === null) {
      labelNode.classList.add('monaco-diff-label-hidden')
      return
    }

    labelNode.classList.remove('monaco-diff-label-hidden')

    const paneRect = paneDomNode.getBoundingClientRect()
    const paneLayout = paneEditor.getLayoutInfo()
    const horizontalInset = paneRect.left - containerRect.left + paneLayout.contentLeft + 12
    const width = Math.max(0, paneLayout.contentWidth - 24)

    labelNode.style.left = `${horizontalInset}px`
    labelNode.style.width = `${width}px`
    labelNode.dataset.align = alignment
  }
}

function createDiffLabelNode(text: string, variant: 'original' | 'modified') {
  const labelNode = document.createElement('div')
  labelNode.className = 'monaco-diff-pane-label'
  labelNode.dataset.variant = variant
  labelNode.append(createDiffLabelBadge(text, variant))
  return labelNode
}

function createDiffInlineLegend(originalLabel: string, modifiedLabel: string) {
  const legendNode = document.createElement('div')
  legendNode.className = 'monaco-diff-inline-legend'

  const separatorNode = document.createElement('span')
  separatorNode.className = 'monaco-diff-inline-separator'
  separatorNode.textContent = 'vs'

  legendNode.append(
    createDiffLabelBadge(originalLabel, 'original'),
    separatorNode,
    createDiffLabelBadge(modifiedLabel, 'modified'),
  )

  return legendNode
}

function createDiffLabelBadge(text: string, variant: 'original' | 'modified') {
  const badgeNode = document.createElement('span')
  badgeNode.className = 'monaco-diff-label-badge'
  badgeNode.dataset.variant = variant
  badgeNode.textContent = text
  return badgeNode
}
