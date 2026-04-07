import {
  ensureMarkdownExtension,
  getName,
  getParentPath,
  joinNotePath,
  normalizeEntryName,
  normalizeRelativeCreatePath,
} from '#web/notes/paths.ts'
import type { AppSettings } from '#web/schemas.ts'
import type { ListedEntry, NoteStorage, StoredFile } from '#web/storage/types.ts'

export type NoteConflict = {
  path: string
  preferredMode: 'popover' | 'diff'
  draftContent: string
  diskFile: StoredFile | null
  loadedSnapshot: StoredFile | null
  source: 'local' | 'remote'
}

export type SaveCurrentNoteResult =
  | { status: 'unchanged' }
  | { status: 'saved'; file: StoredFile }
  | { status: 'reloaded' }
  | { status: 'conflict'; conflict: NoteConflict }

export type MoveFileResult =
  | { didMove: false; message: string | null }
  | { didMove: true; message: null }

export type OpenNoteSyncSnapshot = {
  path: string
  content: string
}

export type RefreshWorkspaceOptions = {
  openNoteSyncSnapshot?: OpenNoteSyncSnapshot | null
}

export type NoteContext = {
  storage(): NoteStorage | null
  entries(): ListedEntry[]
  currentPath(): string | null
  noteConflict(): NoteConflict | null
  setCurrentPath(path: string | null): void
  draftContent(): string
  setDraftContent(content: string): void
  settings(): AppSettings
  saveSettings(nextSettings: AppSettings): Promise<void>
  setEntries(entries: ListedEntry[]): void
  setErrorMessage(message: string | null): void
  setEditorValue(value: string): void
  loadedFileSnapshot(): StoredFile | null
  setLoadedFileSnapshot(file: StoredFile | null): void
  setNoteConflict(conflict: NoteConflict | null): void
}

function isSameStoredFile(left: StoredFile | null, right: StoredFile | null): boolean {
  if (left === null || right === null) {
    return left === right
  }

  return left.path === right.path && left.contentHash === right.contentHash
}

async function applyLoadedFile(context: NoteContext, file: StoredFile): Promise<void> {
  context.setCurrentPath(file.path)
  context.setDraftContent(file.content)
  context.setEditorValue(file.content)
  context.setLoadedFileSnapshot(file)
  await context.saveSettings({
    ...context.settings(),
    lastOpenedPath: file.path,
  })
}

function clearLoadedFile(context: NoteContext) {
  context.setCurrentPath(null)
  context.setDraftContent('')
  context.setEditorValue('')
  context.setLoadedFileSnapshot(null)
}

function clearConflictForPath(context: NoteContext, path: string | null) {
  if (path === null) {
    return
  }

  if (context.noteConflict()?.path === path) {
    context.setNoteConflict(null)
  }
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

function shouldKeepCurrentNoteDuringRefresh(
  context: NoteContext,
  nextPath: string,
  nextFile: StoredFile | null,
  options: RefreshWorkspaceOptions,
): boolean {
  const snapshot = options.openNoteSyncSnapshot ?? null

  if (snapshot === null || snapshot.path !== nextPath || context.currentPath() !== nextPath) {
    return false
  }

  if (nextFile?.content === snapshot.content) {
    return true
  }

  return context.draftContent() !== snapshot.content
}

export async function loadNote(context: NoteContext, path: string | null): Promise<void> {
  const currentStorage = context.storage()

  if (currentStorage === null || path === null) {
    clearLoadedFile(context)
    return
  }

  const file = await currentStorage.readTextFile(path)

  if (file === null) {
    await refreshWorkspace(context, null)
    return
  }

  await applyLoadedFile(context, file)
}

export async function refreshWorkspace(
  context: NoteContext,
  preferredPath: string | null,
  options: RefreshWorkspaceOptions = {},
): Promise<void> {
  const currentStorage = context.storage()

  if (currentStorage === null) {
    return
  }

  const nextEntries = await currentStorage.listEntries()
  context.setEntries(nextEntries)
  const nextPath = pickOpenPath(nextEntries, context.currentPath(), preferredPath)

  if (nextPath === null) {
    clearLoadedFile(context)
    return
  }

  const nextFile = await currentStorage.readTextFile(nextPath)

  if (nextFile === null) {
    await refreshWorkspace(context, null, options)
    return
  }

  if (shouldKeepCurrentNoteDuringRefresh(context, nextPath, nextFile, options)) {
    return
  }

  await applyLoadedFile(context, nextFile)
}

export async function saveCurrentNote(context: NoteContext): Promise<SaveCurrentNoteResult> {
  const currentStorage = context.storage()
  const path = context.currentPath()

  if (currentStorage === null || path === null) {
    return { status: 'unchanged' }
  }

  const draftContent = context.draftContent()
  const loadedSnapshot = context.loadedFileSnapshot()
  const diskFile = await currentStorage.readTextFile(path)

  if (loadedSnapshot !== null && isSameStoredFile(diskFile, loadedSnapshot)) {
    if (draftContent === loadedSnapshot.content) {
      clearConflictForPath(context, path)
      return { status: 'unchanged' }
    }

    const file = await currentStorage.writeTextFile(path, draftContent)
    context.setLoadedFileSnapshot(file)
    clearConflictForPath(context, path)
    return { status: 'saved', file }
  }

  if (loadedSnapshot !== null && draftContent === loadedSnapshot.content) {
    clearConflictForPath(context, path)

    if (diskFile === null) {
      await refreshWorkspace(context, null)
      return { status: 'reloaded' }
    }

    await applyLoadedFile(context, diskFile)
    return { status: 'reloaded' }
  }

  if (loadedSnapshot === null) {
    if (diskFile !== null && draftContent === diskFile.content) {
      context.setLoadedFileSnapshot(diskFile)
      clearConflictForPath(context, path)
      return { status: 'unchanged' }
    }

    if (diskFile === null) {
      if (draftContent.length === 0) {
        clearConflictForPath(context, path)
        return { status: 'unchanged' }
      }

      const file = await currentStorage.writeTextFile(path, draftContent)
      context.setLoadedFileSnapshot(file)
      clearConflictForPath(context, path)
      return { status: 'saved', file }
    }
  }

  const conflict: NoteConflict = {
    path,
    preferredMode: 'popover',
    draftContent,
    diskFile,
    loadedSnapshot,
    source: 'local',
  }

  context.setNoteConflict(conflict)
  return { status: 'conflict', conflict }
}

function getCreateErrorMessage(kind: ListedEntry['kind']): string {
  return kind === 'directory' ? 'Enter a valid folder path.' : 'Enter a valid note path.'
}

function getRenameErrorMessage(kind: ListedEntry['kind']): string {
  return kind === 'directory' ? 'Enter a valid folder name.' : 'Enter a valid note name.'
}

function getFailureMessage(message: string, error: unknown): string {
  if (error instanceof Error && error.message.includes('Name is not allowed')) {
    return message
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}

function getCreateFailureMessage(kind: ListedEntry['kind'], error: unknown): string {
  return getFailureMessage(getCreateErrorMessage(kind), error)
}

function getRenameFailureMessage(kind: ListedEntry['kind'], error: unknown): string {
  return getFailureMessage(getRenameErrorMessage(kind), error)
}

function getConflictingEntryName(kind: ListedEntry['kind'], name: string): string {
  return kind === 'directory' ? name : ensureMarkdownExtension(name)
}

function getRenameTargetPath(entry: ListedEntry, name: string): string {
  return joinNotePath(getParentPath(entry.path), name)
}

function hasRenameConflict(entries: ListedEntry[], entry: ListedEntry, nextPath: string): boolean {
  const descendantPrefix = `${nextPath}/`

  return entries.some((candidate) => {
    if (candidate.path === entry.path) {
      return false
    }

    return candidate.path === nextPath || (entry.kind === 'directory' && candidate.path.startsWith(descendantPrefix))
  })
}

function getPreferredRenamePath(currentPath: string | null, path: string, nextPath: string): string | null {
  if (currentPath === null) {
    return null
  }

  if (currentPath === path) {
    return nextPath
  }

  return currentPath.startsWith(`${path}/`) ? `${nextPath}${currentPath.slice(path.length)}` : currentPath
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
      await refreshWorkspace(context, path)
      return null
    }

    await currentStorage.createDirectory(path)
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

export async function renameEntry(context: NoteContext, entry: ListedEntry, name: string): Promise<string | null> {
  const currentStorage = context.storage()

  if (currentStorage === null) {
    return 'Storage is not ready yet.'
  }

  context.setErrorMessage(null)

  const normalizedName = normalizeEntryName(name)

  if (normalizedName.length === 0) {
    return getRenameErrorMessage(entry.kind)
  }

  const nextPath = getRenameTargetPath(entry, normalizedName)

  if (nextPath === entry.path) {
    return null
  }

  if (hasRenameConflict(context.entries(), entry, nextPath)) {
    return `An entry named "${normalizedName}" already exists here.`
  }

  try {
    await currentStorage.renameEntry(entry.path, nextPath, entry.kind)
    await refreshWorkspace(context, getPreferredRenamePath(context.currentPath(), entry.path, nextPath))
    return null
  } catch (error) {
    return getRenameFailureMessage(entry.kind, error)
  }
}

export async function moveFile(context: NoteContext, path: string, parentPath: string | null): Promise<MoveFileResult> {
  const currentStorage = context.storage()

  if (currentStorage === null) {
    return {
      didMove: false,
      message: 'Storage is not ready yet.',
    }
  }

  context.setErrorMessage(null)

  const entry: ListedEntry = {
    kind: 'file',
    path,
  }
  const nextPath = joinNotePath(parentPath, getName(path))

  if (nextPath === path) {
    return {
      didMove: false,
      message: null,
    }
  }

  if (hasRenameConflict(context.entries(), entry, nextPath)) {
    return {
      didMove: false,
      message: `An entry named "${getName(nextPath)}" already exists here.`,
    }
  }

  try {
    await currentStorage.renameEntry(path, nextPath, 'file')
    await refreshWorkspace(context, getPreferredRenamePath(context.currentPath(), path, nextPath))
    return {
      didMove: true,
      message: null,
    }
  } catch (error) {
    return {
      didMove: false,
      message: getRenameFailureMessage('file', error),
    }
  }
}

export async function deleteEntry(context: NoteContext, entry: ListedEntry | null): Promise<boolean> {
  const currentStorage = context.storage()

  if (currentStorage === null || entry === null) {
    return false
  }

  const message =
    entry.kind === 'directory' ? `Delete folder ${entry.path} and all its contents?` : `Delete ${entry.path}?`

  if (!window.confirm(message)) {
    return false
  }

  context.setErrorMessage(null)
  await currentStorage.deleteEntry(entry.path)
  await refreshWorkspace(context, context.currentPath())
  return true
}
