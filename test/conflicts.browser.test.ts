import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { RemoteFile, SyncBaseEntry } from '../server/schemas.ts'

type SyncSnapshotResponse = {
  files: RemoteFile[]
  conflicts: Array<{
    path: string
    theirs: RemoteFile | null
  }>
}

function createBaseEntry(file: RemoteFile | null): SyncBaseEntry | null {
  if (file === null) {
    return null
  }

  return {
    path: file.path,
    contentHash: file.contentHash,
    updatedAt: file.updatedAt,
    deletedAt: file.deletedAt,
  }
}

async function getSyncSnapshot(request: APIRequestContext): Promise<SyncSnapshotResponse> {
  const response = await request.get('/api/sync/snapshot')
  expect(response.ok()).toBe(true)
  return (await response.json()) as SyncSnapshotResponse
}

async function getRemoteFile(request: APIRequestContext, path: string): Promise<RemoteFile | null> {
  const snapshot = await getSyncSnapshot(request)
  return snapshot.files.find((file) => file.path === path) ?? null
}

async function getRemoteFiles(request: APIRequestContext, prefix: string): Promise<RemoteFile[]> {
  const snapshot = await getSyncSnapshot(request)
  return snapshot.files.filter((file) => file.path.startsWith(prefix)).sort((left, right) => left.path.localeCompare(right.path))
}

async function pushRemoteFile(request: APIRequestContext, path: string, content: string): Promise<void> {
  const remoteFile = await getRemoteFile(request, path)

  expect(remoteFile).not.toBeNull()

  const response = await request.post('/api/sync/push', {
    data: {
      changes: [
        {
          kind: 'upsert',
          path,
          content,
          updatedAt: new Date().toISOString(),
          base: createBaseEntry(remoteFile),
        },
      ],
    },
  })

  expect(response.ok()).toBe(true)
}

async function pushRemoteDelete(request: APIRequestContext, path: string): Promise<void> {
  const remoteFile = await getRemoteFile(request, path)

  expect(remoteFile).not.toBeNull()

  const response = await request.post('/api/sync/push', {
    data: {
      changes: [
        {
          kind: 'delete',
          path,
          updatedAt: new Date().toISOString(),
          base: createBaseEntry(remoteFile),
        },
      ],
    },
  })

  expect(response.ok()).toBe(true)
}

async function waitForSyncIdle(page: Page): Promise<void> {
  const syncButton = page.getByRole('button', { name: /^Sync/ })
  await expect(syncButton).toBeVisible()
  await expect.poll(async () => await syncButton.getAttribute('aria-busy')).not.toBe('true')
}

async function createNote(page: Page, path: string): Promise<void> {
  await page.getByRole('button', { name: 'New note' }).click()

  const input = page.locator('.tree-row-editor input')
  await expect(input).toBeVisible()
  await input.fill(path)
  await input.press('Enter')

  await expect(page.getByRole('button', { name: path.split('/').at(-1) ?? path, exact: true })).toBeVisible()
}

async function replaceEditorContent(page: Page, content: string, options: { diff?: boolean } = {}): Promise<void> {
  const editor = page.locator(options.diff ? '.monaco-diff-editor .editor.modified' : '.monaco-editor').last()
  const namedInput = editor.getByRole('textbox', { name: 'Editor content' })
  const input = (await namedInput.count()) > 0 ? namedInput.first() : editor.getByRole('textbox').last()

  await expect(editor).toBeVisible()
  await editor.click({ position: { x: 120, y: 24 } })
  await input.focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(content)
}

async function clickSync(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Sync/ }).click()
}

async function readOpfsFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (targetPath) => {
    const root = await navigator.storage.getDirectory()
    const segments = targetPath.split('/').filter((segment) => segment.length > 0)
    const name = segments.pop()

    if (name === undefined) {
      return null
    }

    let directory = root

    for (const segment of segments) {
      try {
        directory = await directory.getDirectoryHandle(segment)
      } catch {
        return null
      }
    }

    try {
      const file = await (await directory.getFileHandle(name)).getFile()
      return await file.text()
    } catch {
      return null
    }
  }, path)
}

async function listOpfsFiles(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate(async (targetPrefix) => {
    async function walk(directory: FileSystemDirectoryHandle, currentPrefix = ''): Promise<string[]> {
      const paths: string[] = []

      for await (const [name, handle] of directory.entries()) {
        const nextPath = currentPrefix.length > 0 ? `${currentPrefix}/${name}` : name

        if (handle.kind === 'directory') {
          paths.push(...(await walk(handle, nextPath)))
          continue
        }

        paths.push(nextPath)
      }

      return paths
    }

    return (await walk(await navigator.storage.getDirectory())).filter((path) => path.startsWith(targetPrefix)).sort()
  }, prefix)
}

type RemoteConflictScenario = {
  folder: string
  fileName: string
  path: string
  baseContent: string
  remoteContent: string
  localContent: string
}

type RemoteDeletionConflictScenario = {
  folder: string
  fileName: string
  path: string
  baseContent: string
  localContent: string
}

async function setupRemoteConflict(page: Page, request: APIRequestContext): Promise<RemoteConflictScenario> {
  const runId = randomUUID()
  const folder = `e2e/${runId}`
  const fileName = `conflict-${runId}.md`
  const path = `${folder}/${fileName}`
  const baseContent = '# Base version\n'
  const remoteContent = '# Cloud version\n'
  const localContent = '# Local draft\n'

  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await expect(page.getByRole('button', { name: 'New note' })).toBeEnabled()
  await waitForSyncIdle(page)

  await createNote(page, path)
  await replaceEditorContent(page, baseContent)
  await clickSync(page)

  await expect.poll(async () => await readOpfsFile(page, path)).toBe(baseContent)
  await expect.poll(async () => (await getRemoteFile(request, path))?.content ?? null).toBe(baseContent)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])

  await pushRemoteFile(request, path, remoteContent)
  await expect.poll(async () => (await getRemoteFile(request, path))?.content ?? null).toBe(remoteContent)

  await replaceEditorContent(page, localContent)
  await clickSync(page)

  const conflictButton = page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) })
  const noteButton = page.getByRole('button', { name: fileName, exact: true })

  await expect(conflictButton).toBeVisible()
  await expect(noteButton).toHaveClass(/tree-entry-conflict/)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(localContent)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])

  return {
    folder,
    fileName,
    path,
    baseContent,
    remoteContent,
    localContent,
  }
}

async function setupRemoteDeletionConflict(page: Page, request: APIRequestContext): Promise<RemoteDeletionConflictScenario> {
  const runId = randomUUID()
  const folder = `e2e/${runId}`
  const fileName = `deletion-${runId}.md`
  const path = `${folder}/${fileName}`
  const baseContent = '# Base version\n'
  const localContent = '# Local draft after cloud deletion\n'

  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await expect(page.getByRole('button', { name: 'New note' })).toBeEnabled()
  await waitForSyncIdle(page)

  await createNote(page, path)
  await replaceEditorContent(page, baseContent)
  await clickSync(page)

  await expect.poll(async () => await readOpfsFile(page, path)).toBe(baseContent)
  await expect.poll(async () => (await getRemoteFile(request, path))?.content ?? null).toBe(baseContent)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])

  await pushRemoteDelete(request, path)
  await expect.poll(async () => {
    const remoteFile = await getRemoteFile(request, path)
    return remoteFile === null ? null : remoteFile.deletedAt !== null
  }).toBe(true)

  await replaceEditorContent(page, localContent)
  await clickSync(page)

  const conflictButton = page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) })
  const noteButton = page.getByRole('button', { name: fileName, exact: true })

  await expect(conflictButton).toBeVisible()
  await expect(noteButton).toHaveClass(/tree-entry-conflict/)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(localContent)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])

  return {
    folder,
    fileName,
    path,
    baseContent,
    localContent,
  }
}

function getConflictCopyPath(paths: string[], originalPath: string): string {
  expect(paths).toHaveLength(2)
  const copyPath = paths.find((path) => path !== originalPath)

  expect(copyPath).toBeDefined()
  expect(copyPath).toContain('.conflict-')

  return copyPath as string
}

test('handles a remote conflict in Monaco diff mode without creating an automatic conflict copy', async ({ page, request }) => {
  test.slow()

  const { folder, fileName, path } = await setupRemoteConflict(page, request)
  const mergedContent = '# Merged resolution\n'

  const conflictButton = page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) })

  await expect(conflictButton).toBeVisible()

  await conflictButton.click()
  await page.getByRole('button', { name: 'Resolve conflicting changes' }).click()

  await expect(page.locator('.monaco-diff-editor')).toBeVisible()
  await expect(page.locator('.editor-diff-summary strong')).toHaveText('Resolve conflict')
  await expect(page.getByRole('button', { name: 'Save resolved version' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save cloud version' })).toBeVisible()
  await expect(page.locator('.monaco-diff-label-layer')).toContainText('Cloud version')
  await expect(page.locator('.monaco-diff-label-layer')).toContainText('Current draft')

  await replaceEditorContent(page, mergedContent, { diff: true })
  await page.getByRole('button', { name: 'Save resolved version' }).click()

  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: fileName, exact: true })).not.toHaveClass(/tree-entry-conflict/)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(mergedContent)
  await expect.poll(async () => (await getRemoteFile(request, path))?.content ?? null).toBe(mergedContent)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])
})

test('accepts the cloud version for a remote conflict', async ({ page, request }) => {
  const { folder, path, remoteContent } = await setupRemoteConflict(page, request)

  const conflictButton = page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) })

  await conflictButton.click()
  await page.getByRole('button', { name: 'Accept cloud version' }).click()

  await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toHaveCount(0)
  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(remoteContent)
  await expect.poll(async () => (await getRemoteFile(request, path))?.content ?? null).toBe(remoteContent)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])
  await expect(page.locator('.monaco-editor .view-lines').last()).toContainText('# Cloud version')
})

test('saves the current draft separately for a remote conflict', async ({ page, request }) => {
  const { folder, fileName, path, localContent, remoteContent } = await setupRemoteConflict(page, request)
  const originalButton = page.getByRole('button', { name: fileName, exact: true })

  const conflictButton = page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) })

  await conflictButton.click()
  await page.getByRole('button', { name: 'Save my current draft separately' }).click()

  await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toHaveCount(0)
  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
  await expect.poll(async () => (await listOpfsFiles(page, `${folder}/`)).length).toBe(2)

  const paths = await listOpfsFiles(page, `${folder}/`)
  const copyPath = getConflictCopyPath(paths, path)
  const copyName = copyPath.split('/').at(-1) ?? copyPath

  await expect.poll(async () => await readOpfsFile(page, path)).toBe(remoteContent)
  await expect.poll(async () => await readOpfsFile(page, copyPath)).toBe(localContent)
  await expect(originalButton).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('button', { name: copyName, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: copyName, exact: true })).not.toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.monaco-editor .view-lines').last()).toContainText('# Cloud version')
  await expect.poll(async () => (await getRemoteFile(request, path))?.content ?? null).toBe(remoteContent)
  await expect.poll(async () => (await getRemoteFiles(request, `${folder}/`)).length).toBe(2)
  await expect.poll(async () => {
    const remoteFiles = await getRemoteFiles(request, `${folder}/`)
    return remoteFiles.find((file) => file.path === copyPath)?.content ?? null
  }).toBe(localContent)

  expect(paths).toEqual([copyPath, path].sort())
})

test('handles a remote deletion conflict with deletion-specific labels', async ({ page, request }) => {
  const { folder, fileName, path } = await setupRemoteDeletionConflict(page, request)

  const conflictButton = page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) })
  const noteButton = page.getByRole('button', { name: fileName, exact: true })

  await conflictButton.click()
  await expect(page.getByRole('button', { name: 'Accept cloud deletion' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save my current draft separately' })).toBeVisible()
  await page.getByRole('button', { name: 'Resolve conflicting changes' }).click()

  await expect(page.locator('.monaco-diff-editor')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save cloud deletion' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
  await expect(conflictButton).toBeVisible()
  await conflictButton.click()
  await page.getByRole('button', { name: 'Accept cloud deletion' }).click()

  await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toHaveCount(0)
  await expect(noteButton).toHaveCount(0)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(null)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([])
  await expect.poll(async () => {
    const remoteFile = await getRemoteFile(request, path)
    return remoteFile === null ? null : remoteFile.deletedAt !== null
  }).toBe(true)
})
