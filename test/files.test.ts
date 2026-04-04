import { describe, expect, it } from 'vitest'
import { createConflictCopyPath, normalizeNotePath } from '../server/files.ts'
import { ensureMarkdownExtension, joinNotePath, normalizeRelativeCreatePath } from '../web/notes/paths.ts'
import { buildTree } from '../web/notes/tree.ts'

describe('note paths', () => {
  it('normalizes nested note paths', () => {
    expect(normalizeNotePath(' notes\\ideas//today.md ')).toBe('notes/ideas/today.md')
    expect(normalizeNotePath('./bad-path')).toBe('')
  })

  it('adds the markdown extension when needed', () => {
    expect(ensureMarkdownExtension('notes/plan')).toBe('notes/plan.md')
    expect(ensureMarkdownExtension('notes/plan.md')).toBe('notes/plan.md')
    expect(joinNotePath('notes/daily', 'today.md')).toBe('notes/daily/today.md')
  })

  it('accepts nested relative create paths and rejects escaping input', () => {
    expect(normalizeRelativeCreatePath(' notes/today.md ')).toBe('notes/today.md')
    expect(normalizeRelativeCreatePath('../today.md')).toBe('')
    expect(normalizeRelativeCreatePath('~/today.md')).toBe('')
    expect(normalizeRelativeCreatePath('/tmp/today.md')).toBe('')
    expect(normalizeRelativeCreatePath('C:\\Users\\flo\\today.md')).toBe('')
  })

  it('creates filesystem-safe conflict file names', () => {
    expect(createConflictCopyPath('notes/today.md', '2026-04-03T09:10:11.000Z')).toBe(
      'notes/today.conflict-2026-04-03T09-10-11-000Z.md',
    )
  })
})

describe('tree building', () => {
  it('builds a nested tree with directories before files', () => {
    const tree = buildTree([
      { kind: 'file', path: 'notes/daily/today.md' },
      { kind: 'file', path: 'notes/inbox.md' },
      { kind: 'directory', path: 'archive' },
    ])

    expect(tree.map((node) => node.path)).toEqual(['archive', 'notes'])
    expect(tree[1]?.children.map((node) => node.path)).toEqual(['notes/daily', 'notes/inbox.md'])
    expect(tree[1]?.children[0]?.children.map((node) => node.path)).toEqual(['notes/daily/today.md'])
  })
})
