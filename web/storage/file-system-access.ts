import { hashContent } from '../notes/hashes.ts'
import { normalizeNotePath } from '../notes/paths.ts'
import { isDirectoryPickerSupported, type ListedEntry, type NoteStorage, type StoredFile } from './types.ts'

function isMissingEntryError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')
  )
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

  const directory = await getDirectoryHandleAtPath(root, segments.join('/'), create)

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

export async function pickDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
  if (!isDirectoryPickerSupported()) {
    throw new Error('This browser does not support picking a folder')
  }

  return window.showDirectoryPicker({ mode: 'readwrite' })
}

export async function hasDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const readWritePermission = await handle.queryPermission({ mode: 'readwrite' })

  if (readWritePermission === 'granted') {
    return true
  }

  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
}

export function createDirectoryStorage(root: FileSystemDirectoryHandle): NoteStorage {
  return {
    key: 'directory',
    label: root.name,
    async listEntries() {
      return listDirectory(root)
    },
    async listFiles() {
      const entries = await listDirectory(root)
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
      const handle = await getFileHandleAtPath(root, path, false)

      if (handle === null) {
        return null
      }

      return toStoredFile(normalizeNotePath(path), await handle.getFile())
    },
    async writeTextFile(path, content) {
      const normalizedPath = normalizeNotePath(path)
      const handle = await getFileHandleAtPath(root, normalizedPath, true)

      if (handle === null) {
        throw new Error(`Unable to open ${normalizedPath}`)
      }

      const writable = await handle.createWritable()
      await writable.write(content)
      await writable.close()

      return toStoredFile(normalizedPath, await handle.getFile())
    },
    async deleteEntry(path) {
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
    },
    async createDirectory(path) {
      const directory = await getDirectoryHandleAtPath(root, path, true)

      if (directory === null) {
        throw new Error(`Unable to create ${path}`)
      }
    },
  }
}
