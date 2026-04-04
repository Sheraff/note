import { ensureMarkdownExtension, getParentPath, normalizeNotePath } from '../notes/paths.ts'
import type { AppSettings } from '../schemas.ts'
import type { ListedEntry, NoteStorage } from '../storage/types.ts'

export type NoteContext = {
  storage(): NoteStorage | null
  currentPath(): string | null
  setCurrentPath(path: string | null): void
  draftContent(): string
  setDraftContent(content: string): void
  settings(): AppSettings
  saveSettings(nextSettings: AppSettings): Promise<void>
  setEntries(entries: ListedEntry[]): void
  setStatusMessage(message: string): void
  setIsSaving(value: boolean): void
  setErrorMessage(message: string | null): void
  setEditorValue(value: string): void
}

function pickOpenPath(
  entries: ListedEntry[],
  currentPath: string | null,
  preferredPath: string | null,
): string | null {
  const filePaths = entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path)

  return (
    (preferredPath !== null && filePaths.includes(preferredPath) && preferredPath) ||
    (currentPath !== null && filePaths.includes(currentPath) && currentPath) ||
    filePaths[0] ||
    null
  )
}

export async function loadNote(context: NoteContext, path: string | null): Promise<void> {
  const currentStorage = context.storage()

  if (currentStorage === null || path === null) {
    context.setCurrentPath(null)
    context.setDraftContent('')
    context.setEditorValue('')
    return
  }

  const file = await currentStorage.readTextFile(path)

  if (file === null) {
    await refreshWorkspace(context, null)
    return
  }

  context.setCurrentPath(file.path)
  context.setDraftContent(file.content)
  context.setEditorValue(file.content)
  await context.saveSettings({
    ...context.settings(),
    lastOpenedPath: file.path,
  })
}

export async function refreshWorkspace(context: NoteContext, preferredPath: string | null): Promise<void> {
  const currentStorage = context.storage()

  if (currentStorage === null) {
    return
  }

  const nextEntries = await currentStorage.listEntries()
  context.setEntries(nextEntries)
  await loadNote(context, pickOpenPath(nextEntries, context.currentPath(), preferredPath))
}

export async function saveCurrentNote(context: NoteContext): Promise<void> {
  const currentStorage = context.storage()
  const path = context.currentPath()

  if (currentStorage === null || path === null) {
    return
  }

  context.setIsSaving(true)

  try {
    await currentStorage.writeTextFile(path, context.draftContent())
    context.setStatusMessage(`Saved ${path}`)
  } finally {
    context.setIsSaving(false)
  }
}

export async function createNote(context: NoteContext) {
  const currentStorage = context.storage()

  if (currentStorage === null) {
    return
  }

  const defaultDirectory = getParentPath(context.currentPath() ?? '')
  const defaultPath = defaultDirectory === null ? 'untitled.md' : `${defaultDirectory}/untitled.md`
  const value = window.prompt('New note path', defaultPath)

  if (value === null) {
    return
  }

  const path = ensureMarkdownExtension(value)

  if (path.length === 0) {
    context.setErrorMessage('Enter a valid note path.')
    return
  }

  context.setErrorMessage(null)
  await currentStorage.writeTextFile(path, '# Untitled\n')
  context.setStatusMessage(`Created ${path}`)
  await refreshWorkspace(context, path)
}

export async function createFolder(context: NoteContext) {
  const currentStorage = context.storage()

  if (currentStorage === null) {
    return
  }

  const defaultDirectory = getParentPath(context.currentPath() ?? '') ?? 'notes'
  const value = window.prompt('New folder path', defaultDirectory)

  if (value === null) {
    return
  }

  const path = normalizeNotePath(value)

  if (path.length === 0) {
    context.setErrorMessage('Enter a valid folder path.')
    return
  }

  context.setErrorMessage(null)
  await currentStorage.createDirectory(path)
  context.setStatusMessage(`Created folder ${path}`)
  await refreshWorkspace(context, context.currentPath())
}

export async function deleteCurrentNote(context: NoteContext) {
  const currentStorage = context.storage()
  const path = context.currentPath()

  if (currentStorage === null || path === null) {
    return
  }

  if (!window.confirm(`Delete ${path}?`)) {
    return
  }

  context.setErrorMessage(null)
  await currentStorage.deleteEntry(path)
  context.setStatusMessage(`Deleted ${path}`)
  await refreshWorkspace(context, null)
}
