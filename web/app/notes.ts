import { ensureMarkdownExtension, joinNotePath, normalizeRelativeCreatePath } from '../notes/paths.ts'
import type { AppSettings } from '../schemas.ts'
import type { ListedEntry, NoteStorage } from '../storage/types.ts'

export type NoteContext = {
  storage(): NoteStorage | null
  entries(): ListedEntry[]
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

function getCreateErrorMessage(kind: ListedEntry['kind']): string {
  return kind === 'directory' ? 'Enter a valid folder path.' : 'Enter a valid note path.'
}

function getCreateFailureMessage(kind: ListedEntry['kind'], error: unknown): string {
  if (error instanceof Error && error.message.includes('Name is not allowed')) {
    return getCreateErrorMessage(kind)
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}

function getConflictingEntryName(kind: ListedEntry['kind'], name: string): string {
  return kind === 'directory' ? name : ensureMarkdownExtension(name)
}

async function createEntry(
  context: NoteContext,
  kind: ListedEntry['kind'],
  parentPath: string | null,
  name: string,
): Promise<string | null> {
  const currentStorage = context.storage()

  if (currentStorage === null) {
    return 'Storage is not ready yet.'
  }

  context.setErrorMessage(null)

  const normalizedName = normalizeRelativeCreatePath(name)

  if (normalizedName.length === 0) {
    return getCreateErrorMessage(kind)
  }

  const path = joinNotePath(parentPath, getConflictingEntryName(kind, normalizedName))

  if (context.entries().some((entry) => entry.path === path)) {
    return `An entry named "${getConflictingEntryName(kind, normalizedName)}" already exists here.`
  }

  try {
    if (kind === 'file') {
      await currentStorage.writeTextFile(path, '# Untitled\n')
      context.setStatusMessage(`Created ${path}`)
      await refreshWorkspace(context, path)
      return null
    }

    await currentStorage.createDirectory(path)
    context.setStatusMessage(`Created folder ${path}`)
    await refreshWorkspace(context, context.currentPath())
    return null
  } catch (error) {
    return getCreateFailureMessage(kind, error)
  }
}

export async function createNote(context: NoteContext, parentPath: string | null, name: string): Promise<string | null> {
  return createEntry(context, 'file', parentPath, name)
}

export async function createFolder(
  context: NoteContext,
  parentPath: string | null,
  name: string,
): Promise<string | null> {
  return createEntry(context, 'directory', parentPath, name)
}

export async function deleteEntry(context: NoteContext, entry: ListedEntry | null) {
  const currentStorage = context.storage()

  if (currentStorage === null || entry === null) {
    return
  }

  const message =
    entry.kind === 'directory' ? `Delete folder ${entry.path} and all its contents?` : `Delete ${entry.path}?`

  if (!window.confirm(message)) {
    return
  }

  context.setErrorMessage(null)
  await currentStorage.deleteEntry(entry.path)
  context.setStatusMessage(entry.kind === 'directory' ? `Deleted folder ${entry.path}` : `Deleted ${entry.path}`)
  await refreshWorkspace(context, context.currentPath())
}
