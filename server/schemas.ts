import * as v from 'valibot'
import { normalizeNotePath } from './files.ts'

const TimestampSchema = v.pipe(v.string(), v.minLength(1))
export const SyncCursorSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

export const NotePathSchema = v.pipe(
  v.string(),
  v.transform((value) => normalizeNotePath(value)),
  v.minLength(1),
)

export const ContentHashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))

export const TextFileContentSchema = v.object({
  encoding: v.literal('text'),
  value: v.string(),
})

export const BlobFileContentSchema = v.object({
  encoding: v.literal('blob'),
  hash: ContentHashSchema,
  size: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

export const FileContentSchema = v.variant('encoding', [TextFileContentSchema, BlobFileContentSchema])

export const SyncBaseEntrySchema = v.object({
  path: NotePathSchema,
  contentHash: v.nullable(ContentHashSchema),
  updatedAt: TimestampSchema,
  deletedAt: v.nullable(TimestampSchema),
})

export const RemoteFileSchema = v.object({
  path: NotePathSchema,
  content: v.nullable(FileContentSchema),
  contentHash: v.nullable(ContentHashSchema),
  updatedAt: TimestampSchema,
  deletedAt: v.nullable(TimestampSchema),
})

export const ManifestEntrySchema = v.object({
  path: NotePathSchema,
  contentHash: v.nullable(ContentHashSchema),
  updatedAt: TimestampSchema,
  deletedAt: v.nullable(TimestampSchema),
})

export const UpsertChangeSchema = v.object({
  kind: v.literal('upsert'),
  path: NotePathSchema,
  content: FileContentSchema,
  updatedAt: TimestampSchema,
  base: v.nullable(SyncBaseEntrySchema),
})

export const DeleteChangeSchema = v.object({
  kind: v.literal('delete'),
  path: NotePathSchema,
  updatedAt: TimestampSchema,
  base: v.nullable(SyncBaseEntrySchema),
})

export const SyncChangeSchema = v.variant('kind', [UpsertChangeSchema, DeleteChangeSchema])

export const PushRequestSchema = v.object({
  sinceCursor: SyncCursorSchema,
  changes: v.array(SyncChangeSchema),
})

export const SyncConflictSchema = v.object({
  path: NotePathSchema,
  theirs: v.nullable(RemoteFileSchema),
})

export const HealthResponseSchema = v.object({
  ok: v.boolean(),
})

export const SessionResponseSchema = v.object({
  userId: v.string(),
})

export const AuthRedirectResponseSchema = v.object({
  redirect: v.string(),
})

export const SyncResponseSchema = v.object({
  files: v.array(RemoteFileSchema),
  conflicts: v.array(SyncConflictSchema),
  cursor: SyncCursorSchema,
})

export type SyncBaseEntry = v.InferOutput<typeof SyncBaseEntrySchema>
export type FileContent = v.InferOutput<typeof FileContentSchema>
export type RemoteFile = v.InferOutput<typeof RemoteFileSchema>
export type ManifestEntry = v.InferOutput<typeof ManifestEntrySchema>
export type SyncChange = v.InferOutput<typeof SyncChangeSchema>
export type SyncConflict = v.InferOutput<typeof SyncConflictSchema>
export type PushRequest = v.InferOutput<typeof PushRequestSchema>
export type SessionResponse = v.InferOutput<typeof SessionResponseSchema>
export type AuthRedirectResponse = v.InferOutput<typeof AuthRedirectResponseSchema>
