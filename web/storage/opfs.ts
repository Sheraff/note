import { hashContent } from '../notes/hashes.ts'
import { normalizeNotePath } from '../notes/paths.ts'
import type { ListedEntry, NoteStorage, StoredFile } from './types.ts'

function isMissingEntryError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')
  )
}

async function getRootDirectory(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

async function getDirectoryHandleAtPath(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  const normalized = normalizeNotePath(path)

  if (normalized.length === 0) {
    return root
  }

  let current = root

  for (const segment of normalized.split('/')) {
    try {
      current = await current.getDirectoryHandle(segment, { create })
    } catch (error) {
      if (isMissingEntryError(error)) {
        return null
      }

      throw error
    }
  }

  return current
}

async function getFileHandleAtPath(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle | null> {
  const normalized = normalizeNotePath(path)
  const segments = normalized.split('/')
  const name = segments.pop()

  if (name === undefined || name.length === 0) {
    return null
  }

  const directoryPath = segments.join('/')
  const directory = await getDirectoryHandleAtPath(root, directoryPath, create)

  if (directory === null) {
    return null
  }

  try {
    return await directory.getFileHandle(name, { create })
  } catch (error) {
    if (isMissingEntryError(error)) {
      return null
    }

    throw error
  }
}

async function toStoredFile(path: string, file: File): Promise<StoredFile> {
  const content = await file.text()

  return {
    path,
    content,
    contentHash: await hashContent(content),
    updatedAt: new Date(file.lastModified).toISOString(),
  }
}

async function listDirectory(directory: FileSystemDirectoryHandle, prefix = ''): Promise<ListedEntry[]> {
  const entries: ListedEntry[] = []

  for await (const [name, handle] of directory.entries()) {
    const nextPath = prefix.length > 0 ? `${prefix}/${name}` : name
    entries.push({
      kind: handle.kind,
      path: nextPath,
    })

    if (handle.kind === 'directory') {
      entries.push(...(await listDirectory(handle, nextPath)))
    }
  }

  return entries
}

async function readTextFileContent(root: FileSystemDirectoryHandle, path: string): Promise<string> {
  const normalizedPath = normalizeNotePath(path)
  const handle = await getFileHandleAtPath(root, normalizedPath, false)

  if (handle === null) {
    throw new Error(`Unable to open ${normalizedPath}`)
  }

  return (await handle.getFile()).text()
}

async function writeStoredTextFile(
  root: FileSystemDirectoryHandle,
  path: string,
  content: string,
): Promise<StoredFile> {
  const normalizedPath = normalizeNotePath(path)
  const handle = await getFileHandleAtPath(root, normalizedPath, true)

  if (handle === null) {
    throw new Error(`Unable to open ${normalizedPath}`)
  }

  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()

  return toStoredFile(normalizedPath, await handle.getFile())
}

async function deleteEntryAtPath(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const normalizedPath = normalizeNotePath(path)
  const segments = normalizedPath.split('/')
  const name = segments.pop()

  if (name === undefined || name.length === 0) {
    return
  }

  const directory = await getDirectoryHandleAtPath(root, segments.join('/'), false)

  if (directory === null) {
    return
  }

  try {
    await directory.removeEntry(name, { recursive: true })
  } catch (error) {
    if (!isMissingEntryError(error)) {
      throw error
    }
  }
}

async function createDirectoryAtPath(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const directory = await getDirectoryHandleAtPath(root, path, true)

  if (directory === null) {
    throw new Error(`Unable to create ${path}`)
  }
}

async function copyTextFile(root: FileSystemDirectoryHandle, path: string, nextPath: string): Promise<void> {
  await writeStoredTextFile(root, nextPath, await readTextFileContent(root, path))
}

async function renameEntryAtPath(
  root: FileSystemDirectoryHandle,
  path: string,
  nextPath: string,
  kind: ListedEntry['kind'],
): Promise<void> {
  const normalizedPath = normalizeNotePath(path)
  const normalizedNextPath = normalizeNotePath(nextPath)

  if (kind === 'file') {
    await copyTextFile(root, normalizedPath, normalizedNextPath)
    await deleteEntryAtPath(root, normalizedPath)
    return
  }

  const directory = await getDirectoryHandleAtPath(root, normalizedPath, false)

  if (directory === null) {
    throw new Error(`Unable to open ${normalizedPath}`)
  }

  await createDirectoryAtPath(root, normalizedNextPath)

  for (const entry of await listDirectory(directory, normalizedPath)) {
    const relativePath = entry.path.slice(normalizedPath.length + 1)
    const nextEntryPath = normalizeNotePath(`${normalizedNextPath}/${relativePath}`)

    if (entry.kind === 'directory') {
      await createDirectoryAtPath(root, nextEntryPath)
      continue
    }

    await copyTextFile(root, entry.path, nextEntryPath)
  }

  await deleteEntryAtPath(root, normalizedPath)
}

export function createOpfsStorage(): NoteStorage {
  return {
    key: 'opfs',
    label: 'OPFS',
    async listEntries() {
      return listDirectory(await getRootDirectory())
    },
    async listFiles() {
      const entries = await listDirectory(await getRootDirectory())
      const files: StoredFile[] = []

      for (const entry of entries) {
        if (entry.kind !== 'file') {
          continue
        }

        const file = await this.readTextFile(entry.path)

        if (file !== null) {
          files.push(file)
        }
      }

      return files
    },
    async readTextFile(path) {
      const handle = await getFileHandleAtPath(await getRootDirectory(), path, false)

      if (handle === null) {
        return null
      }

      return toStoredFile(normalizeNotePath(path), await handle.getFile())
    },
    async writeTextFile(path, content) {
      return writeStoredTextFile(await getRootDirectory(), path, content)
    },
    async deleteEntry(path) {
      await deleteEntryAtPath(await getRootDirectory(), path)
    },
    async createDirectory(path) {
      await createDirectoryAtPath(await getRootDirectory(), path)
    },
    async renameEntry(path, nextPath, kind) {
      await renameEntryAtPath(await getRootDirectory(), path, nextPath, kind)
    },
  }
}
