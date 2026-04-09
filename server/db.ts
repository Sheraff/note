import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as v from 'valibot'
import { type FileContent, type RemoteFile, RemoteFileSchema } from './schemas.ts'

const testDatabaseSuffix = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? ''
const databaseFileName = testDatabaseSuffix.length > 0 ? `note.${testDatabaseSuffix}.sqlite` : 'note.sqlite'
const databasePath = resolve(process.cwd(), 'data', databaseFileName)

mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })

const database = new DatabaseSync(databasePath)

database.exec(`
  CREATE TABLE IF NOT EXISTS files (
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT,
    content_encoding TEXT,
    content_hash TEXT,
    size INTEGER,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    sync_cursor INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, path)
  ) STRICT
`)

database.exec(`
  CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    size INTEGER NOT NULL
  ) STRICT
`)

database.exec(`
  CREATE TABLE IF NOT EXISTS user_blobs (
    user_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (user_id, hash)
  ) STRICT
`)

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
  content: v.nullable(v.string()),
  content_encoding: v.nullable(v.string()),
  content_hash: v.nullable(v.string()),
  size: v.nullable(v.number()),
  updated_at: v.string(),
  deleted_at: v.nullable(v.string()),
})

const CursorRowSchema = v.object({
  cursor: v.number(),
})

const BlobRowSchema = v.object({
  content: v.custom<Uint8Array>((value) => value instanceof Uint8Array),
  size: v.number(),
})

const BlobSizeRowSchema = v.object({
  size: v.number(),
})

const BlobContentSizeSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

const selectFilesStatement = database.prepare(`
  SELECT path, content, content_encoding, content_hash, size, updated_at, deleted_at
  FROM files
  WHERE user_id = ?
  ORDER BY path ASC
`)

const selectFilesSinceCursorStatement = database.prepare(`
  SELECT path, content, content_encoding, content_hash, size, updated_at, deleted_at
  FROM files
  WHERE user_id = ? AND sync_cursor > ?
  ORDER BY path ASC
`)

const selectCurrentSyncCursorStatement = database.prepare(`
  SELECT COALESCE(MAX(sync_cursor), 0) AS cursor
  FROM files
`)

const upsertFileStatement = database.prepare(`
  INSERT INTO files (user_id, path, content, content_encoding, content_hash, size, updated_at, deleted_at, sync_cursor)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, path) DO UPDATE SET
    content = excluded.content,
    content_encoding = excluded.content_encoding,
    content_hash = excluded.content_hash,
    size = excluded.size,
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at,
    sync_cursor = excluded.sync_cursor
`)

const upsertBlobStatement = database.prepare(`
  INSERT INTO blobs (hash, content, size)
  VALUES (?, ?, ?)
  ON CONFLICT(hash) DO NOTHING
`)

const selectBlobStatement = database.prepare(`
  SELECT content, size
  FROM blobs
  WHERE hash = ?
`)

const selectBlobSizeStatement = database.prepare(`
  SELECT size
  FROM blobs
  WHERE hash = ?
`)

const selectUserBlobReferenceStatement = database.prepare(`
  SELECT 1 AS has_reference
  FROM user_blobs
  WHERE user_id = ? AND hash = ?
  LIMIT 1
`)

const insertUserBlobReferenceStatement = database.prepare(`
  INSERT INTO user_blobs (user_id, hash)
  VALUES (?, ?)
  ON CONFLICT(user_id, hash) DO NOTHING
`)

function toDatabaseContent(content: FileContent | null): {
  content: string | null
  contentEncoding: string | null
  size: number | null
} {
  if (content === null) {
    return {
      content: null,
      contentEncoding: null,
      size: null,
    }
  }

  if (content.encoding === 'blob') {
    return {
      content: content.hash,
      contentEncoding: content.encoding,
      size: content.size,
    }
  }

  return {
    content: content.value,
    contentEncoding: content.encoding,
    size: Buffer.byteLength(content.value, 'utf8'),
  }
}

function fromDatabaseContent(content: string | null, contentEncoding: string | null, size: number | null): FileContent | null {
  if (content === null) {
    return null
  }

  if (contentEncoding === 'blob') {
    return v.parse(RemoteFileSchema.entries.content, {
      encoding: 'blob',
      hash: content,
      size: v.parse(BlobContentSizeSchema, size),
    })
  }

  if (contentEncoding === 'text') {
    return v.parse(RemoteFileSchema.entries.content, {
      encoding: 'text',
      value: content,
    })
  }

  throw new Error(`Unsupported file content encoding: ${contentEncoding ?? 'null'}`)
}

function toRemoteFiles(rows: unknown): RemoteFile[] {
  return v.parse(v.array(DatabaseRowSchema), rows).map((row) =>
    v.parse(RemoteFileSchema, {
      path: row.path,
      content: fromDatabaseContent(row.content, row.content_encoding, row.size),
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
  const databaseContent = toDatabaseContent(validated.content)

  if (validated.content?.encoding === 'blob') {
    insertUserBlobReferenceStatement.run(userId, validated.content.hash)
  }

  upsertFileStatement.run(
    userId,
    validated.path,
    databaseContent.content,
    databaseContent.contentEncoding,
    validated.contentHash,
    databaseContent.size,
    validated.updatedAt,
    validated.deletedAt,
    syncCursor,
  )
}

export function upsertBlob(hash: string, content: Uint8Array): void {
  upsertBlobStatement.run(hash, Buffer.from(content), content.byteLength)
}

export function getBlob(hash: string): { content: Uint8Array; size: number } | null {
  const row = selectBlobStatement.get(hash)

  if (row === undefined) {
    return null
  }

  const parsed = v.parse(BlobRowSchema, row)

  return {
    content: Uint8Array.from(parsed.content),
    size: parsed.size,
  }
}

export function getBlobSize(hash: string): number | null {
  const row = selectBlobSizeStatement.get(hash)

  if (row === undefined) {
    return null
  }

  return v.parse(BlobSizeRowSchema, row).size
}

export function userHasBlob(userId: string, hash: string): boolean {
  return selectUserBlobReferenceStatement.get(userId, hash) !== undefined
}
