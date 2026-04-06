import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Browser, type Page, type Request as BrowserRequest } from '@playwright/test'
import type { RemoteFile, SyncBaseEntry } from '../server/schemas.ts'

type SyncSnapshotResponse = {
  files: RemoteFile[]
  conflicts: Array<{
    path: string
    theirs: RemoteFile | null
  }>
}

const TEST_USER_HEADER = 'X-Note-User'

async function installTestUserHeader(page: Page, userId: string): Promise<void> {
  await page.addInitScript(
    ({ headerName, headerValue }) => {
      const originalFetch = window.fetch.bind(window)

      window.fetch = async (input, init) => {
        const headers = new Headers(init?.headers)

        headers.set(headerName, headerValue)

        return originalFetch(input, {
          ...init,
          headers,
        })
      }
    },
    { headerName: TEST_USER_HEADER, headerValue: userId },
  )
}

function withTestUser(userId?: string): { headers?: Record<string, string> } {
  if (userId === undefined) {
    return {}
  }

  return {
    headers: {
      [TEST_USER_HEADER]: userId,
    },
  }
}

async function createIsolatedBrowserPage(browser: Browser, userId: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173',
    extraHTTPHeaders: {
      [TEST_USER_HEADER]: userId,
    },
  })

  return context.newPage()
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

async function getSyncSnapshot(request: APIRequestContext, userId?: string): Promise<SyncSnapshotResponse> {
  const response = await request.get('/api/sync/snapshot', withTestUser(userId))
  expect(response.ok()).toBe(true)
  return (await response.json()) as SyncSnapshotResponse
}

async function getRemoteFile(request: APIRequestContext, path: string, userId?: string): Promise<RemoteFile | null> {
  const snapshot = await getSyncSnapshot(request, userId)
  return snapshot.files.find((file) => file.path === path) ?? null
}

async function getRemoteFiles(request: APIRequestContext, prefix: string, userId?: string): Promise<RemoteFile[]> {
  const snapshot = await getSyncSnapshot(request, userId)
  return snapshot.files.filter((file) => file.path.startsWith(prefix)).sort((left, right) => left.path.localeCompare(right.path))
}

async function pushRemoteFile(request: APIRequestContext, path: string, content: string, userId?: string): Promise<void> {
  const remoteFile = await getRemoteFile(request, path, userId)

  expect(remoteFile).not.toBeNull()

  const response = await request.post('/api/sync/push', {
    ...withTestUser(userId),
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

async function createRemoteFileOnServer(request: APIRequestContext, path: string, content: string, userId?: string): Promise<void> {
  const response = await request.post('/api/sync/push', {
    ...withTestUser(userId),
    data: {
      changes: [
        {
          kind: 'upsert',
          path,
          content,
          updatedAt: new Date().toISOString(),
          base: null,
        },
      ],
    },
  })

  expect(response.ok()).toBe(true)
}

async function pushRemoteDelete(request: APIRequestContext, path: string, userId?: string): Promise<void> {
  const remoteFile = await getRemoteFile(request, path, userId)

  expect(remoteFile).not.toBeNull()

  const response = await request.post('/api/sync/push', {
    ...withTestUser(userId),
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

async function countSyncRequestsDuring(page: Page, action: () => Promise<void>): Promise<number> {
  let requestCount = 0

  const handleRequest = (request: BrowserRequest) => {
    const url = request.url()

    if (url.endsWith('/api/sync/manifest') || url.endsWith('/api/sync/push')) {
      requestCount += 1
    }
  }

  page.on('request', handleRequest)

  try {
    await action()
    await page.waitForTimeout(250)
  } finally {
    page.off('request', handleRequest)
  }

  return requestCount
}

async function replaceEditorContent(page: Page, content: string, options: { diff?: boolean } = {}): Promise<void> {
  const editor = page.locator(options.diff ? '.monaco-diff-editor .editor.modified' : '.monaco-editor').last()
  const namedInput = editor.getByRole('textbox', { name: 'Editor content' })
  const input = (await namedInput.count()) > 0 ? namedInput.first() : editor.getByRole('textbox').last()
  const expectedLines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  await expect(editor).toBeVisible()
  await editor.click({ position: { x: 120, y: 24 } })
  await input.focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(content)

  if (expectedLines.length > 0) {
    for (const line of expectedLines) {
      await expect(editor.locator('.view-lines').last()).toContainText(line)
    }
  }
}

async function reloadAndReadSyncResponse(page: Page): Promise<SyncSnapshotResponse> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/sync/push') && response.request().method() === 'POST',
  )

  await page.reload()
  const response = await responsePromise

  expect(response.ok()).toBe(true)
  return (await response.json()) as SyncSnapshotResponse
}

async function reloadAndWaitForSync(page: Page): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/sync/push') && response.request().method() === 'POST',
  )

  await page.reload()
  const response = await responsePromise

  expect(response.ok()).toBe(true)
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

async function writeOpfsFile(page: Page, path: string, content: string): Promise<void> {
  await page.evaluate(
    async ({ targetPath, nextContent }) => {
      const root = await navigator.storage.getDirectory()
      const segments = targetPath.split('/').filter((segment) => segment.length > 0)
      const name = segments.pop()

      if (name === undefined) {
        throw new Error('Expected a file path')
      }

      let directory = root

      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment, { create: true })
      }

      const handle = await directory.getFileHandle(name, { create: true })
      const writable = await handle.createWritable()
      await writable.write(nextContent)
      await writable.close()
    },
    { nextContent: content, targetPath: path },
  )
}

type RemoteConflictScenario = {
  folder: string
  fileName: string
  path: string
  baseContent: string
  remoteContent: string
  localContent: string
  userId: string
}

type RemoteDeletionConflictScenario = {
  folder: string
  fileName: string
  path: string
  baseContent: string
  localContent: string
}

type RemoteConflictWithSiblingScenario = {
  folder: string
  conflictFileName: string
  conflictPath: string
  remoteContent: string
  localContent: string
  siblingFileName: string
  siblingPath: string
  siblingContent: string
}

type MultipleRemoteConflictScenario = {
  conflictPaths: string[]
  files: Array<{
    fileName: string
    localContent: string
    path: string
    remoteContent: string
  }>
  folder: string
  userId: string
}

async function setupRemoteConflict(page: Page, request: APIRequestContext, userId?: string): Promise<RemoteConflictScenario> {
  const effectiveUserId = userId ?? `browser-${randomUUID()}`
  const runId = randomUUID()
  const folder = `e2e/${runId}`
  const fileName = `conflict-${runId}.md`
  const path = `${folder}/${fileName}`
  const baseContent = '# Base version\n'
  const remoteContent = '# Cloud version\n'
  const localContent = '# Local draft\n'

  await installTestUserHeader(page, effectiveUserId)
  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  await writeOpfsFile(page, path, baseContent)
  await createRemoteFileOnServer(request, path, baseContent, effectiveUserId)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(baseContent)
  await expect.poll(async () => (await getRemoteFile(request, path, effectiveUserId))?.content ?? null).toBe(baseContent)
  await reloadAndWaitForSync(page)
  await expect(page).toHaveTitle('Note')
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])

  await pushRemoteFile(request, path, remoteContent, effectiveUserId)
  await expect.poll(async () => (await getRemoteFile(request, path, effectiveUserId))?.content ?? null).toBe(remoteContent)

  await writeOpfsFile(page, path, localContent)
  await reloadAndWaitForSync(page)
  await expect(page).toHaveTitle('Note')

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
    userId: effectiveUserId,
  }
}

async function setupRemoteDeletionConflict(
  page: Page,
  request: APIRequestContext,
  userId?: string,
): Promise<RemoteDeletionConflictScenario> {
  const runId = randomUUID()
  const folder = `e2e/${runId}`
  const fileName = `deletion-${runId}.md`
  const path = `${folder}/${fileName}`
  const baseContent = '# Base version\n'
  const localContent = '# Local draft after cloud deletion\n'

  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  await writeOpfsFile(page, path, baseContent)
  await createRemoteFileOnServer(request, path, baseContent, userId)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(baseContent)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(baseContent)
  await reloadAndWaitForSync(page)
  await expect(page).toHaveTitle('Note')
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])

  await pushRemoteDelete(request, path, userId)
  await expect.poll(async () => {
    const remoteFile = await getRemoteFile(request, path, userId)
    return remoteFile === null ? null : remoteFile.deletedAt !== null
  }).toBe(true)

  await writeOpfsFile(page, path, localContent)
  const syncResponse = await reloadAndReadSyncResponse(page)

  expect(syncResponse.conflicts).toHaveLength(1)
  expect(syncResponse.conflicts[0]?.path).toBe(path)
  await waitForSyncIdle(page)

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

async function setupRemoteConflictWithSibling(page: Page, request: APIRequestContext, userId: string): Promise<RemoteConflictWithSiblingScenario> {
  const runId = randomUUID()
  const folder = `e2e/${runId}`
  const conflictFileName = `switch-conflict-${runId}.md`
  const conflictPath = `${folder}/${conflictFileName}`
  const siblingFileName = `switch-sibling-${runId}.md`
  const siblingPath = `${folder}/${siblingFileName}`
  const baseContent = '# Base version\n'
  const remoteContent = '# Cloud version after reopen\n'
  const localContent = '# Local draft before reopen\n'
  const siblingContent = '# Sibling note\n'

  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  await writeOpfsFile(page, conflictPath, baseContent)
  await createRemoteFileOnServer(request, conflictPath, baseContent, userId)
  await expect.poll(async () => await readOpfsFile(page, conflictPath)).toBe(baseContent)
  await expect.poll(async () => (await getRemoteFile(request, conflictPath, userId))?.content ?? null).toBe(baseContent)

  await writeOpfsFile(page, siblingPath, siblingContent)
  await createRemoteFileOnServer(request, siblingPath, siblingContent, userId)
  await expect.poll(async () => await readOpfsFile(page, siblingPath)).toBe(siblingContent)
  await expect.poll(async () => (await getRemoteFile(request, siblingPath, userId))?.content ?? null).toBe(siblingContent)
  await reloadAndWaitForSync(page)
  await expect(page).toHaveTitle('Note')
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([conflictPath, siblingPath].sort())

  await pushRemoteFile(request, conflictPath, remoteContent, userId)
  await expect.poll(async () => (await getRemoteFile(request, conflictPath, userId))?.content ?? null).toBe(remoteContent)

  await writeOpfsFile(page, conflictPath, localContent)
  await reloadAndWaitForSync(page)
  await expect(page).toHaveTitle('Note')

  const noteButton = page.getByRole('button', { name: conflictFileName, exact: true })

  await expect(noteButton).toHaveClass(/tree-entry-conflict/)
  await expect.poll(async () => await readOpfsFile(page, conflictPath)).toBe(localContent)
  await expect.poll(async () => await readOpfsFile(page, siblingPath)).toBe(siblingContent)

  return {
    folder,
    conflictFileName,
    conflictPath,
    remoteContent,
    localContent,
    siblingFileName,
    siblingPath,
    siblingContent,
  }
}

async function setupMultipleRemoteConflicts(page: Page, request: APIRequestContext, userId?: string): Promise<MultipleRemoteConflictScenario> {
  const effectiveUserId = userId ?? `browser-${randomUUID()}`
  const runId = randomUUID()
  const folder = `e2e/${runId}`
  const files = [
    {
      fileName: `multi-a-${runId}.md`,
      localContent: '# Local A\n',
      path: `${folder}/multi-a-${runId}.md`,
      remoteContent: '# Cloud A\n',
    },
    {
      fileName: `multi-b-${runId}.md`,
      localContent: '# Local B\n',
      path: `${folder}/multi-b-${runId}.md`,
      remoteContent: '# Cloud B\n',
    },
  ]

  await installTestUserHeader(page, effectiveUserId)
  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  for (const [index, file] of files.entries()) {
    const baseContent = `# Base ${index + 1}\n`

    await writeOpfsFile(page, file.path, baseContent)
    await createRemoteFileOnServer(request, file.path, baseContent, effectiveUserId)
    await expect.poll(async () => await readOpfsFile(page, file.path)).toBe(baseContent)
    await expect.poll(async () => (await getRemoteFile(request, file.path, effectiveUserId))?.content ?? null).toBe(baseContent)
  }

  await reloadAndWaitForSync(page)
  await expect(page).toHaveTitle('Note')
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual(files.map((file) => file.path).sort())

  for (const file of files) {
    await pushRemoteFile(request, file.path, file.remoteContent, effectiveUserId)
    await expect.poll(async () => (await getRemoteFile(request, file.path, effectiveUserId))?.content ?? null).toBe(file.remoteContent)
    await writeOpfsFile(page, file.path, file.localContent)
    await expect.poll(async () => await readOpfsFile(page, file.path)).toBe(file.localContent)
  }

  const syncResponse = await reloadAndReadSyncResponse(page)
  expect(syncResponse.conflicts).toHaveLength(2)
  const queuedConflictPath = syncResponse.conflicts[1]?.path

  expect(queuedConflictPath).toBeDefined()

  const queuedConflict = files.find((file) => file.path === queuedConflictPath)

  expect(queuedConflict).toBeDefined()
  await expect.poll(async () => await readOpfsFile(page, queuedConflict!.path)).toBe(queuedConflict!.remoteContent)
  await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toBeVisible()

  return {
    conflictPaths: syncResponse.conflicts.map((conflict) => conflict.path),
    files,
    folder,
    userId: effectiveUserId,
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

  const { folder, fileName, path, userId } = await setupRemoteConflict(page, request)
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
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(mergedContent)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])
})

test('accepts the cloud version for a remote conflict', async ({ page, request }) => {
  const { folder, path, remoteContent, userId } = await setupRemoteConflict(page, request)

  const conflictButton = page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) })

  await conflictButton.click()
  await page.getByRole('button', { name: 'Accept cloud version' }).click()

  await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toHaveCount(0)
  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(remoteContent)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(remoteContent)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual([path])
  await expect(page.locator('.monaco-editor .view-lines').last()).toContainText('# Cloud version')
})

test('saves the current draft separately for a remote conflict', async ({ browser, request }) => {
  const userId = `browser-${randomUUID()}`
  const page = await createIsolatedBrowserPage(browser, userId)

  try {
    const { folder, fileName, path, localContent, remoteContent } = await setupRemoteConflict(page, request, userId)
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
    await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(remoteContent)
    await expect.poll(async () => (await getRemoteFiles(request, `${folder}/`, userId)).length).toBe(2)
    await expect.poll(async () => {
      const remoteFiles = await getRemoteFiles(request, `${folder}/`, userId)
      return remoteFiles.find((file) => file.path === copyPath)?.content ?? null
    }).toBe(localContent)

    expect(paths).toEqual([copyPath, path].sort())
  } finally {
    await page.context().close()
  }
})

test('handles a remote deletion conflict with deletion-specific labels', async ({ browser, request }) => {
  const userId = `browser-${randomUUID()}`
  const page = await createIsolatedBrowserPage(browser, userId)

  try {
    const { folder, fileName, path } = await setupRemoteDeletionConflict(page, request, userId)

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
      const remoteFile = await getRemoteFile(request, path, userId)
      return remoteFile === null ? null : remoteFile.deletedAt !== null
    }).toBe(true)
  } finally {
    await page.context().close()
  }
})

test('reopens an unresolved conflict in diff mode after switching notes and then resolves it', async ({ browser, request }) => {
  const userId = `browser-${randomUUID()}`
  const page = await createIsolatedBrowserPage(browser, userId)

  try {
    const {
      conflictFileName,
      conflictPath,
      siblingFileName,
      siblingContent,
    } = await setupRemoteConflictWithSibling(page, request, userId)
    const mergedContent = '# Resolved after reopening diff\n'

    const conflictNoteButton = page.getByRole('button', { name: conflictFileName, exact: true })
    const siblingNoteButton = page.getByRole('button', { name: siblingFileName, exact: true })

    await conflictNoteButton.click()
    await page.getByRole('button', { name: 'Resolve conflicting changes' }).click()

    await expect(page.locator('.monaco-diff-editor')).toBeVisible()
    await expect(page.locator('.editor-diff-path')).toHaveText(conflictPath)
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
    await expect(conflictNoteButton).toHaveClass(/tree-entry-conflict/)
    await expect(page.locator('.monaco-editor .view-lines').last()).toContainText('# Local draft before reopen')

    await siblingNoteButton.click()

    await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
    await expect(siblingNoteButton).toHaveAttribute('aria-current', 'true')
    await expect(conflictNoteButton).toHaveClass(/tree-entry-conflict/)
    await expect(page.locator('.monaco-editor .view-lines').last()).toContainText(siblingContent.trim())

    await conflictNoteButton.click()

    await expect(page.locator('.monaco-diff-editor')).toBeVisible()
    await expect(page.locator('.editor-diff-path')).toHaveText(conflictPath)
    await replaceEditorContent(page, mergedContent, { diff: true })
    await page.getByRole('button', { name: 'Save resolved version' }).click()

    await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toHaveCount(0)
    await expect(conflictNoteButton).toHaveAttribute('aria-current', 'true')
    await expect(conflictNoteButton).not.toHaveClass(/tree-entry-conflict/)
    await expect(page.locator('.monaco-editor .view-lines').last()).toContainText(mergedContent.trim())
    await expect.poll(async () => await readOpfsFile(page, conflictPath)).toBe(mergedContent)
    await expect.poll(async () => (await getRemoteFile(request, conflictPath, userId))?.content ?? null).toBe(mergedContent)
  } finally {
    await page.context().close()
  }
})

test('keeps later conflicts unresolved when multiple cloud conflicts arrive in one sync', async ({ page, request }) => {
  const { conflictPaths, files, folder, userId } = await setupMultipleRemoteConflicts(page, request)
  const initialConflictButton = page.getByRole('button', { name: /Cloud conflict:/ })
  const firstConflict = files.find((file) => file.path === conflictPaths[0])
  const secondConflict = files.find((file) => file.path === conflictPaths[1])

  expect(firstConflict).toBeDefined()
  expect(secondConflict).toBeDefined()

  await initialConflictButton.click()
  await page.getByRole('button', { name: 'Save my current draft', exact: true }).click()

  await expect.poll(async () => (await getRemoteFile(request, firstConflict!.path, userId))?.content ?? null).toBe(firstConflict!.localContent)
  await expect.poll(async () => (await getRemoteFile(request, secondConflict!.path, userId))?.content ?? null).toBe(secondConflict!.remoteContent)
  await expect.poll(async () => await readOpfsFile(page, secondConflict!.path)).toBe(secondConflict!.localContent)

  const secondConflictButton = page.getByRole('button', {
    name: new RegExp(`Cloud conflict: ${RegExp.escape(secondConflict!.path)}`),
  })

  await expect(secondConflictButton).toBeVisible()
  await expect(page.getByRole('button', { name: firstConflict!.fileName, exact: true })).not.toHaveClass(/tree-entry-conflict/)
  await expect(page.getByRole('button', { name: secondConflict!.fileName, exact: true })).toHaveClass(/tree-entry-conflict/)

  await secondConflictButton.click()
  await page.getByRole('button', { name: 'Save my current draft', exact: true }).click()

  await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toHaveCount(0)
  await expect.poll(async () => (await getRemoteFile(request, secondConflict!.path, userId))?.content ?? null).toBe(secondConflict!.localContent)
  await expect.poll(async () => await listOpfsFiles(page, `${folder}/`)).toEqual(files.map((file) => file.path).sort())
})

test('opens and dismisses the status bar and tree conflict popovers', async ({ browser, request }) => {
  const userId = `browser-${randomUUID()}`
  const page = await createIsolatedBrowserPage(browser, userId)

  try {
    const { fileName, path } = await setupRemoteConflict(page, request, userId)
    const statusbarConflictButton = page.getByRole('button', {
      name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`),
    })
    const statusbarPopover = page.locator('.statusbar-conflict-popover')
    const treeConflictButton = page.getByRole('button', { name: fileName, exact: true })
    const treePopover = page.locator(`[id="tree-conflict-${path.replaceAll('/', '--')}"]`)

    await expect(statusbarPopover).toBeHidden()
    await statusbarConflictButton.click()
    await expect(statusbarPopover).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(statusbarPopover).toBeHidden()

    await expect(treePopover).toBeHidden()
    await treeConflictButton.click()
    await expect(treePopover).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(treePopover).toBeHidden()
  } finally {
    await page.context().close()
  }
})

test('opens and resolves a cloud conflict from the tree popover', async ({ browser, request }) => {
  const userId = `browser-${randomUUID()}`
  const page = await createIsolatedBrowserPage(browser, userId)

  try {
    const { fileName, path } = await setupRemoteConflict(page, request, userId)
    const resolvedContent = '# Resolved from tree popover\n'
    const treeConflictButton = page.getByRole('button', { name: fileName, exact: true })
    const treePopover = page.locator(`[id="tree-conflict-${path.replaceAll('/', '--')}"]`)

    await treeConflictButton.click()
    await expect(treePopover).toBeVisible()
    await treePopover.getByRole('button', { name: 'Resolve conflicting changes' }).click()

    await expect(page.locator('.monaco-diff-editor')).toBeVisible()
    await replaceEditorContent(page, resolvedContent, { diff: true })
    await page.getByRole('button', { name: 'Save resolved version' }).click()

    await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toHaveCount(0)
    await expect(treeConflictButton).not.toHaveClass(/tree-entry-conflict/)
    await expect.poll(async () => await readOpfsFile(page, path)).toBe(resolvedContent)
    await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(resolvedContent)
  } finally {
    await page.context().close()
  }
})

test('keeps typing in an unresolved plain-editor conflict local until explicit resolution', async ({ browser, request }) => {
  const userId = `browser-${randomUUID()}`
  const page = await createIsolatedBrowserPage(browser, userId)

  try {
    const { localContent, path, remoteContent } = await setupRemoteConflict(page, request, userId)
    const extraDraft = `${localContent}More unresolved typing\n`

    await replaceEditorContent(page, extraDraft)
    await page.waitForTimeout(900)

    await expect(page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) })).toBeVisible()
    await expect.poll(async () => await readOpfsFile(page, path)).toBe(localContent)
    await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(remoteContent)

    await page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) }).click()
    await page.getByRole('button', { name: 'Resolve conflicting changes' }).click()

    await expect(page.locator('.monaco-diff-editor .editor.modified .view-lines').last()).toContainText('More unresolved typing')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('.monaco-editor .view-lines').last()).toContainText('More unresolved typing')
  } finally {
    await page.context().close()
  }
})

test('keeps diff labels and actions usable on a narrow viewport', async ({ page, request }) => {
  await page.setViewportSize({ width: 780, height: 900 })

  const { path, remoteContent } = await setupRemoteConflict(page, request)

  await page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) }).click()
  await page.getByRole('button', { name: 'Resolve conflicting changes' }).click()

  await expect(page.locator('.monaco-diff-editor')).toBeVisible()
  await expect(page.locator('.monaco-diff-inline-legend')).toBeVisible()
  await expect(page.locator('.monaco-diff-inline-legend')).toContainText('Cloud version')
  await expect(page.locator('.monaco-diff-inline-legend')).toContainText('Current draft')
  await expect(page.locator('.monaco-diff-pane-label')).toHaveCount(2)
  await expect(page.locator('.monaco-diff-pane-label.monaco-diff-label-hidden')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Save resolved version' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save cloud version' })).toBeVisible()

  await page.getByRole('button', { name: 'Save cloud version' }).click()

  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Cloud conflict:/ })).toHaveCount(0)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(remoteContent)
})

test('ignores focus, visibility, and online auto-sync triggers while a conflict is unresolved', async ({ page, request }) => {
  const { localContent, path, remoteContent, userId } = await setupRemoteConflict(page, request)
  const updatedDraft = `${localContent}Still unresolved after lifecycle events\n`

  await replaceEditorContent(page, updatedDraft)

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
  })

  expect(syncRequests).toBe(0)
  await expect(page.getByRole('button', { name: new RegExp(`Cloud conflict: ${RegExp.escape(path)}`) })).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines').last()).toContainText('Still unresolved after lifecycle events')
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(localContent)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(remoteContent)
})
