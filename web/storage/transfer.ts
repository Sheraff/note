import { readStoredFile, toWriteFileInput, writeStoredFile, type ListedEntry, type NoteStorage } from './types.ts'

export type StorageTransferConflict = {
  path: string
  sourceKind: ListedEntry['kind']
  destinationKind: ListedEntry['kind']
}

function compareEntryPaths(left: ListedEntry, right: ListedEntry): number {
  const leftDepth = left.path.split('/').length
  const rightDepth = right.path.split('/').length

  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth
  }

  if (left.kind !== right.kind) {
    return left.kind === 'directory' ? -1 : 1
  }

  return left.path.localeCompare(right.path)
}

function compareEntriesForRemoval(left: ListedEntry, right: ListedEntry): number {
  return compareEntryPaths(right, left)
}

async function readRequiredFile(storage: NoteStorage, path: string, action: string) {
  const file = await readStoredFile(storage, path)

  if (file === null) {
    throw new Error(`Unable to read ${path} before ${action}`)
  }

  return file
}

export async function getStorageTransferConflicts(
  source: NoteStorage,
  destination: NoteStorage,
  sourceEntries?: ListedEntry[],
  destinationEntries?: ListedEntry[],
): Promise<StorageTransferConflict[]> {
  const nextSourceEntries = sourceEntries ?? (await source.listEntries())
  const nextDestinationEntries = destinationEntries ?? (await destination.listEntries())
  const destinationByPath = new Map(nextDestinationEntries.map((entry) => [entry.path, entry.kind]))
  const conflicts: StorageTransferConflict[] = []

  for (const sourceEntry of nextSourceEntries) {
    const destinationKind = destinationByPath.get(sourceEntry.path)

    if (destinationKind === undefined) {
      continue
    }

    if (sourceEntry.kind === 'directory' && destinationKind === 'directory') {
      continue
    }

    if (sourceEntry.kind === 'file' && destinationKind === 'file') {
      const sourceFile = await readRequiredFile(source, sourceEntry.path, 'transfer conflict detection')
      const destinationFile = await readRequiredFile(destination, sourceEntry.path, 'transfer conflict detection')

      if (sourceFile.contentHash === destinationFile.contentHash) {
        continue
      }
    }

    conflicts.push({
      path: sourceEntry.path,
      sourceKind: sourceEntry.kind,
      destinationKind,
    })
  }

  return conflicts.sort((left, right) => left.path.localeCompare(right.path))
}

export async function copyStorageEntries(
  source: NoteStorage,
  destination: NoteStorage,
  sourceEntries?: ListedEntry[],
): Promise<void> {
  const entries = sourceEntries ?? (await source.listEntries())

  for (const entry of [...entries].sort(compareEntryPaths)) {
    if (entry.kind === 'directory') {
      await destination.createDirectory(entry.path)
      continue
      }

      const file = await readRequiredFile(source, entry.path, 'transfer')

      await writeStoredFile(destination, entry.path, toWriteFileInput(file))
    }
  }

export async function replaceStorageEntries(
  source: NoteStorage,
  destination: NoteStorage,
  sourceEntries?: ListedEntry[],
  destinationEntries?: ListedEntry[],
): Promise<void> {
  const nextSourceEntries = sourceEntries ?? (await source.listEntries())
  const nextDestinationEntries = destinationEntries ?? (await destination.listEntries())
  const sourceKindsByPath = new Map(nextSourceEntries.map((entry) => [entry.path, entry.kind]))

  for (const entry of [...nextDestinationEntries].sort(compareEntriesForRemoval)) {
    const sourceKind = sourceKindsByPath.get(entry.path)

    if (sourceKind === entry.kind || (sourceKind === 'file' && entry.kind === 'file')) {
      continue
    }

    await destination.deleteEntry(entry.path)
  }

  await copyStorageEntries(source, destination, nextSourceEntries)
}
