export type ListedEntry = {
  kind: 'directory' | 'file'
  path: string
}

export type StoredFile = {
  path: string
  content: string
  contentHash: string
  updatedAt: string
}

export type NoteStorage = {
  key: 'opfs' | 'directory'
  label: string
  listEntries(): Promise<ListedEntry[]>
  listFiles(): Promise<StoredFile[]>
  readTextFile(path: string): Promise<StoredFile | null>
  writeTextFile(path: string, content: string): Promise<StoredFile>
  deleteEntry(path: string): Promise<void>
  createDirectory(path: string): Promise<void>
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}
