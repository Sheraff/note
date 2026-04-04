import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as v from 'valibot'
import { type ManifestEntry, ManifestEntrySchema, type RemoteFile, RemoteFileSchema } from './schemas.ts'

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

database.exec(`
  CREATE INDEX IF NOT EXISTS files_user_updated_at_idx
  ON files (user_id, updated_at)
`)

const DatabaseRowSchema = v.object({
  path: RemoteFileSchema.entries.path,
  content: RemoteFileSchema.entries.content,
  content_hash: v.nullable(v.string()),
  updated_at: v.string(),
  deleted_at: v.nullable(v.string()),
})

const selectFilesStatement = database.prepare(`
  SELECT path, content, content_hash, updated_at, deleted_at
  FROM files
  WHERE user_id = ?
  ORDER BY path ASC
`)

const upsertFileStatement = database.prepare(`
  INSERT INTO files (user_id, path, content, content_hash, updated_at, deleted_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, path) DO UPDATE SET
    content = excluded.content,
    content_hash = excluded.content_hash,
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at
`)

export function listFiles(userId: string): RemoteFile[] {
  const rows = v.parse(v.array(DatabaseRowSchema), selectFilesStatement.all(userId))

  return rows.map((row) =>
    v.parse(RemoteFileSchema, {
      path: row.path,
      content: row.content,
      contentHash: row.content_hash,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    }),
  )
}

export function listManifest(userId: string): ManifestEntry[] {
  return listFiles(userId).map((file) =>
    v.parse(ManifestEntrySchema, {
      path: file.path,
      contentHash: file.contentHash,
      updatedAt: file.updatedAt,
      deletedAt: file.deletedAt,
    }),
  )
}

export function upsertFile(userId: string, file: RemoteFile): void {
  const validated = v.parse(RemoteFileSchema, file)

  upsertFileStatement.run(
    userId,
    validated.path,
    validated.content,
    validated.contentHash,
    validated.updatedAt,
    validated.deletedAt,
  )
}
