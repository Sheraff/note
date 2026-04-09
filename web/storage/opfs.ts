import { isDotStorePath, normalizeNotePath } from '../notes/paths.ts'
import { createStoredFileFromFile } from './file-classify.ts'
import {
  isTextStoredFile,
  readStoredFile,
  toWriteFileInput,
  type ListedEntry,
  type NoteStorage,
  type StoredFile,
  type WriteFileInput,
} from './types.ts'

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

async function listDirectory(directory: FileSystemDirectoryHandle, prefix = ''): Promise<ListedEntry[]> {
  const entries: ListedEntry[] = []

  for await (const [name, handle] of directory.entries()) {
    const nextPath = prefix.length > 0 ? `${prefix}/${name}` : name

    if (handle.kind === 'file' && isDotStorePath(nextPath)) {
      continue
    }

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

async function readStoredFileContent(root: FileSystemDirectoryHandle, path: string): Promise<StoredFile> {
  const normalizedPath = normalizeNotePath(path)
  const handle = await getFileHandleAtPath(root, normalizedPath, false)

  if (handle === null) {
    throw new Error(`Unable to open ${normalizedPath}`)
  }

  return createStoredFileFromFile(normalizedPath, await handle.getFile())
}

async function writeStoredFile(
  root: FileSystemDirectoryHandle,
  path: string,
  file: WriteFileInput,
): Promise<StoredFile> {
  const normalizedPath = normalizeNotePath(path)
  const handle = await getFileHandleAtPath(root, normalizedPath, true)

  if (handle === null) {
    throw new Error(`Unable to open ${normalizedPath}`)
  }

  const writable = await handle.createWritable()

  if (file.format === 'text') {
    await writable.write(file.content)
  } else {
    await writable.write(Uint8Array.from(file.content))
  }

  await writable.close()

  return createStoredFileFromFile(normalizedPath, await handle.getFile())
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

async function copyFile(root: FileSystemDirectoryHandle, path: string, nextPath: string): Promise<void> {
  const file = await readStoredFileContent(root, path)
  await writeStoredFile(root, nextPath, toWriteFileInput(file))
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
    await copyFile(root, normalizedPath, normalizedNextPath)
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

    await copyFile(root, entry.path, nextEntryPath)
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

        const file = await readStoredFile(this, entry.path)

        if (file !== null) {
          files.push(file)
        }
      }

      return files
    },
    async readFile(path) {
      const handle = await getFileHandleAtPath(await getRootDirectory(), path, false)

      if (handle === null) {
        return null
      }

      return createStoredFileFromFile(normalizeNotePath(path), await handle.getFile())
    },
    async writeFile(path, file) {
      return writeStoredFile(await getRootDirectory(), path, file)
    },
    async readTextFile(path) {
      const file = await readStoredFile(this, path)
      return isTextStoredFile(file) ? file : null
    },
    async writeTextFile(path, content) {
      const file = await writeStoredFile(await getRootDirectory(), path, {
        format: 'text',
        content,
      })

      if (!isTextStoredFile(file)) {
        throw new Error(`Expected ${path} to be written as text`)
      }

      return file
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
