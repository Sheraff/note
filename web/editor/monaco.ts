import * as monaco from 'monaco-editor'
// import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { resolveWorkspacePath } from '#web/notes/paths.ts'
import { getStoredFileViewKind } from '#web/storage/file-classify.ts'
import type { StoredFile } from '#web/storage/types.ts'
import './monaco-diff.css'
import './monaco-font.css'
import './monaco-inline-images.css'

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
  getLanguageId(): string
  refresh(): void
  setValue(value: string): void
  setPath(path: string | null): void
  focus(): void
  dispose(): void
}

const DEFAULT_EDITOR_PATH = 'untitled.md'

function createModelUri(path: string | null, fragment?: string): monaco.Uri {
  return monaco.Uri.from({
    scheme: 'file',
    path: `/${path ?? DEFAULT_EDITOR_PATH}`,
    fragment,
  })
}

function createTextModel(value: string, path: string | null, fragment?: string): monaco.editor.ITextModel {
  return monaco.editor.createModel(value, undefined, createModelUri(path, fragment))
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
    path: string | null
    onChange(value: string): void
    readFile(path: string): Promise<StoredFile | null>
  },
): MonacoController {
  let isApplyingValue = false
  let currentPath = options.path

  void ensureMonaspaceFont()

  let model = createTextModel(options.initialValue, currentPath)
  const editor = monaco.editor.create(element, {
    model,
    ...createEditorOptions(),
  })
  const markdownImages = createMarkdownImageLayer(editor, {
    path: () => currentPath,
    readFile: options.readFile,
  })

  void ensureMonaspaceFont().then(() => {
    monaco.editor.remeasureFonts()
    editor.layout()
  })

  editor.onDidChangeModelContent(() => {
    if (isApplyingValue) {
      return
    }

    options.onChange(editor.getValue())
  })
  markdownImages.refresh()

  return {
    getValue() {
      return model.getValue()
    },
    getLanguageId() {
      return model.getLanguageId()
    },
    refresh() {
      markdownImages.refresh()
    },
    setValue(value) {
      if (model.getValue() === value) {
        return
      }

      isApplyingValue = true
      model.setValue(value)
      isApplyingValue = false
    },
    setPath(path) {
      if (currentPath === path) {
        return
      }

      const nextModel = createTextModel(model.getValue(), path)
      editor.setModel(nextModel)
      model.dispose()
      model = nextModel
      currentPath = path
      markdownImages.refresh()
    },
    focus() {
      editor.focus()
    },
    dispose() {
      markdownImages.dispose()
      editor.dispose()
      model.dispose()
    },
  }
}

export function createMonacoDiffEditor(
  element: HTMLElement,
  options: {
    originalValue: string
    modifiedValue: string
    path: string | null
    originalLabel: string
    modifiedLabel: string
    onChange(value: string): void
  },
): MonacoController {
  let isApplyingValue = false
  let currentPath = options.path

  void ensureMonaspaceFont()

  let originalModel = createTextModel(options.originalValue, currentPath, 'original')
  let modifiedModel = createTextModel(options.modifiedValue, currentPath, 'modified')
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

  let modifiedModelSubscription = modifiedModel.onDidChangeContent(() => {
    if (isApplyingValue) {
      return
    }

    options.onChange(modifiedModel.getValue())
  })

  return {
    getValue() {
      return modifiedModel.getValue()
    },
    getLanguageId() {
      return modifiedModel.getLanguageId()
    },
    refresh() {},
    setValue(value) {
      if (modifiedModel.getValue() === value) {
        return
      }

      isApplyingValue = true
      modifiedModel.setValue(value)
      isApplyingValue = false
    },
    setPath(path) {
      if (currentPath === path) {
        return
      }

      const nextOriginalModel = createTextModel(originalModel.getValue(), path, 'original')
      const nextModifiedModel = createTextModel(modifiedModel.getValue(), path, 'modified')

      modifiedModelSubscription.dispose()
      editor.setModel({
        original: nextOriginalModel,
        modified: nextModifiedModel,
      })
      originalModel.dispose()
      modifiedModel.dispose()
      originalModel = nextOriginalModel
      modifiedModel = nextModifiedModel
      currentPath = path
      modifiedModelSubscription = modifiedModel.onDidChangeContent(() => {
        if (isApplyingValue) {
          return
        }

        options.onChange(modifiedModel.getValue())
      })
    },
    focus() {
      modifiedEditor.focus()
    },
    dispose() {
      labelLayer.dispose()
      modifiedModelSubscription.dispose()
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

function createMarkdownImageLayer(
  editor: monaco.editor.IStandaloneCodeEditor,
  options: {
    path(): string | null
    readFile(path: string): Promise<StoredFile | null>
  },
) {
  let zoneIds: string[] = []
  let objectUrls: string[] = []
  let refreshVersion = 0
  let disposed = false
  let refreshTimer: number | undefined
  const subscription = editor.onDidChangeModelContent(() => {
    scheduleRefresh()
  })

  return {
    refresh: scheduleRefresh,
    dispose() {
      disposed = true
      subscription.dispose()

      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer)
      }

      clearZones()
    },
  }

  function scheduleRefresh() {
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer)
    }

    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined
      void refreshMarkdownImages(++refreshVersion)
    }, 0)
  }

  async function refreshMarkdownImages(version: number) {
    if (disposed) {
      return
    }

    const model = editor.getModel()
    const path = options.path()

    if (model === null || path === null || model.getLanguageId() !== 'markdown') {
      clearZones()
      return
    }

    const matches = [...model.getValue().matchAll(/!\[[^\]]*\]\(([^)\r\n]+)\)/g)]

    if (matches.length === 0) {
      clearZones()
      return
    }

    const previews: Array<{ afterLineNumber: number; domNode: HTMLElement; objectUrl: string }> = []

    for (const match of matches) {
      const rawTarget = extractMarkdownImageTarget(match[1])

      if (rawTarget === null) {
        continue
      }

      const resolvedPath = resolveWorkspacePath(path, rawTarget)

      if (resolvedPath === null) {
        continue
      }

      const file = await options.readFile(resolvedPath)

      if (disposed || version !== refreshVersion || file === null || file.format !== 'binary' || getStoredFileViewKind(file) !== 'image') {
        continue
      }

      const objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(file.content)], { type: file.mimeType ?? undefined }))
      const position = model.getPositionAt(match.index ?? 0)

      previews.push({
        afterLineNumber: position.lineNumber,
        domNode: createMarkdownImageNode(objectUrl, resolvedPath),
        objectUrl,
      })
    }

    if (disposed || version !== refreshVersion) {
      for (const preview of previews) {
        URL.revokeObjectURL(preview.objectUrl)
      }

      return
    }

    clearZones()

    if (previews.length === 0) {
      return
    }

    const nextZoneIds: string[] = []

    editor.changeViewZones((accessor) => {
      for (const preview of previews) {
        nextZoneIds.push(
          accessor.addZone({
            afterLineNumber: preview.afterLineNumber,
            domNode: preview.domNode,
            heightInPx: 220,
          }),
        )
      }
    })

    zoneIds = nextZoneIds
    objectUrls = previews.map((preview) => preview.objectUrl)
  }

  function clearZones() {
    if (zoneIds.length > 0) {
      editor.changeViewZones((accessor) => {
        for (const zoneId of zoneIds) {
          accessor.removeZone(zoneId)
        }
      })

      zoneIds = []
    }

    for (const objectUrl of objectUrls) {
      URL.revokeObjectURL(objectUrl)
    }

    objectUrls = []
  }
}

function extractMarkdownImageTarget(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }

  const trimmed = value.trim()

  if (trimmed.length === 0 || /^[a-z]+:/i.test(trimmed)) {
    return null
  }

  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    const target = trimmed.slice(1, -1).trim()
    return target.length === 0 ? null : target
  }

  const target = trimmed.split(/\s+/, 1)[0] ?? ''
  return target.length === 0 ? null : target
}

function createMarkdownImageNode(objectUrl: string, path: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'monaco-inline-image-zone'

  const frame = document.createElement('div')
  frame.className = 'monaco-inline-image-frame'

  const image = document.createElement('img')
  image.src = objectUrl
  image.alt = path

  const label = document.createElement('span')
  label.className = 'monaco-inline-image-label'
  label.textContent = path

  frame.append(image)
  wrapper.append(frame, label)
  return wrapper
}
