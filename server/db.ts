import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as v from 'valibot'
import { type RemoteFile, RemoteFileSchema } from './schemas.ts'

const databasePath = resolve(process.cwd(), 'data', 'note.sqlite')

mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })

const database = new DatabaseSync(databasePath)

database.exec(`
  CREATE TABLE IF NOT EXISTS files (
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT,
    content_hash TEXT,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (user_id, path)
  ) STRICT
`)

const TableInfoRowSchema = v.object({
  name: v.string(),
})

const tableInfoRows = v.parse(v.array(TableInfoRowSchema), database.prepare('PRAGMA table_info(files)').all())

if (!tableInfoRows.some((row) => row.name === 'sync_cursor')) {
  database.exec('ALTER TABLE files ADD COLUMN sync_cursor INTEGER NOT NULL DEFAULT 0')
  database.exec('UPDATE files SET sync_cursor = rowid WHERE sync_cursor = 0')
}

database.exec(`
  CREATE INDEX IF NOT EXISTS files_user_updated_at_idx
  ON files (user_id, updated_at)
`)

database.exec(`
  CREATE INDEX IF NOT EXISTS files_user_sync_cursor_idx
  ON files (user_id, sync_cursor)
`)

const DatabaseRowSchema = v.object({
  path: RemoteFileSchema.entries.path,
  content: RemoteFileSchema.entries.content,
  content_hash: v.nullable(v.string()),
  updated_at: v.string(),
  deleted_at: v.nullable(v.string()),
})

const CursorRowSchema = v.object({
  cursor: v.number(),
})

const selectFilesStatement = database.prepare(`
  SELECT path, content, content_hash, updated_at, deleted_at
  FROM files
  WHERE user_id = ?
  ORDER BY path ASC
`)

const selectFilesSinceCursorStatement = database.prepare(`
  SELECT path, content, content_hash, updated_at, deleted_at
  FROM files
  WHERE user_id = ? AND sync_cursor > ?
  ORDER BY path ASC
`)

const selectCurrentSyncCursorStatement = database.prepare(`
  SELECT COALESCE(MAX(sync_cursor), 0) AS cursor
  FROM files
`)

const upsertFileStatement = database.prepare(`
  INSERT INTO files (user_id, path, content, content_hash, updated_at, deleted_at, sync_cursor)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, path) DO UPDATE SET
    content = excluded.content,
    content_hash = excluded.content_hash,
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at,
    sync_cursor = excluded.sync_cursor
`)

function toRemoteFiles(rows: unknown): RemoteFile[] {
  return v.parse(v.array(DatabaseRowSchema), rows).map((row) =>
    v.parse(RemoteFileSchema, {
      path: row.path,
      content: row.content,
      contentHash: row.content_hash,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    }),
  )
}

export function listFiles(userId: string): RemoteFile[] {
  return toRemoteFiles(selectFilesStatement.all(userId))
}

export function listFilesSinceCursor(userId: string, sinceCursor: number): RemoteFile[] {
  return toRemoteFiles(selectFilesSinceCursorStatement.all(userId, sinceCursor))
}

export function getCurrentSyncCursor(): number {
  return v.parse(CursorRowSchema, selectCurrentSyncCursorStatement.get()).cursor
}

export function getNextSyncCursor(): number {
  return getCurrentSyncCursor() + 1
}

export function upsertFile(userId: string, file: RemoteFile, syncCursor: number): void {
  const validated = v.parse(RemoteFileSchema, file)

  upsertFileStatement.run(
    userId,
    validated.path,
    validated.content,
    validated.contentHash,
    validated.updatedAt,
    validated.deletedAt,
    syncCursor,
  )
}
