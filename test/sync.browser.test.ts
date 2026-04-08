import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Browser, type Dialog, type Page, type Request as BrowserRequest } from '@playwright/test'
import type { RemoteFile, SyncBaseEntry } from '../server/schemas.ts'

type SyncSnapshotResponse = {
  files: RemoteFile[]
  conflicts: Array<{
    path: string
    theirs: RemoteFile | null
  }>
  cursor: number
}

type SyncRequestCounts = {
  manifest: number
  push: number
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

async function createIsolatedBrowserPage(browser: Browser, userId: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173',
    extraHTTPHeaders: {
      [TEST_USER_HEADER]: userId,
    },
  })

  return context.newPage()
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

async function installDateNowHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let mockedNow = Date.now()

    Object.defineProperty(window, '__noteSyncBrowserTestClock', {
      configurable: true,
      value: {
        advanceBy(milliseconds: number) {
          mockedNow += milliseconds
        },
      },
    })

    Date.now = () => mockedNow
  })
}

async function installVisibilityStateHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let mockedVisibilityState: DocumentVisibilityState = document.visibilityState

    Object.defineProperty(window, '__noteSyncBrowserTestVisibility', {
      configurable: true,
      value: {
        set(nextVisibilityState: DocumentVisibilityState) {
          mockedVisibilityState = nextVisibilityState
        },
      },
    })

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get() {
        return mockedVisibilityState
      },
    })

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get() {
        return mockedVisibilityState !== 'visible'
      },
    })
  })
}

async function installPollingHarness(page: Page, pollIntervalMs = 25): Promise<void> {
  await page.addInitScript(({ intervalMs }) => {
    const originalSetInterval = window.setInterval.bind(window)

    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const nextTimeout = timeout === 60_000 ? intervalMs : timeout

      return originalSetInterval(handler, nextTimeout, ...args)
    }) as typeof window.setInterval
  }, { intervalMs: pollIntervalMs })
}

async function advanceDateNow(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((delta) => {
    ;(window as unknown as Window & {
      __noteSyncBrowserTestClock: {
        advanceBy(milliseconds: number): void
      }
    }).__noteSyncBrowserTestClock.advanceBy(delta)
  }, milliseconds)
}

async function setVisibilityState(page: Page, visibilityState: DocumentVisibilityState): Promise<void> {
  await page.evaluate((nextVisibilityState) => {
    ;(window as unknown as Window & {
      __noteSyncBrowserTestVisibility: {
        set(nextVisibilityState: DocumentVisibilityState): void
      }
    }).__noteSyncBrowserTestVisibility.set(nextVisibilityState)
  }, visibilityState)
}

async function dispatchVisibilityChange(page: Page, visibilityState: DocumentVisibilityState): Promise<void> {
  await page.evaluate((nextVisibilityState) => {
    ;(window as unknown as Window & {
      __noteSyncBrowserTestVisibility: {
        set(nextVisibilityState: DocumentVisibilityState): void
      }
    }).__noteSyncBrowserTestVisibility.set(nextVisibilityState)
    document.dispatchEvent(new Event('visibilitychange'))
  }, visibilityState)
}

async function waitForSyncIdle(page: Page): Promise<void> {
  const syncButton = page.getByRole('button', { name: /^Sync/ })
  await expect(syncButton).toBeVisible()
  await expect.poll(async () => await syncButton.getAttribute('aria-busy')).not.toBe('true')
}

async function expectEditorToContain(page: Page, text: string): Promise<void> {
  await expect(page.locator('.monaco-editor .view-lines').last()).toContainText(text)
}

async function focusPlainEditorInput(page: Page): Promise<void> {
  const editor = page.locator('.monaco-editor').last()
  const namedInput = editor.getByRole('textbox', { name: 'Editor content' })
  const input = (await namedInput.count()) > 0 ? namedInput.first() : editor.getByRole('textbox').last()

  await expect(editor).toBeVisible()
  await editor.click({ position: { x: 120, y: 24 } })
  await input.focus()
}

async function replaceEditorContent(page: Page, content: string): Promise<void> {
  const editor = page.locator('.monaco-editor').last()
  const expectedLines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  await focusPlainEditorInput(page)
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(content)

  if (expectedLines.length > 0) {
    for (const line of expectedLines) {
      await expect(editor.locator('.view-lines').last()).toContainText(line)
    }
  }
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

async function readStoredSyncState(
  page: Page,
  userId: string,
): Promise<{
  files: Array<Record<string, unknown>>
  cursor: number
  lastSyncedAt: string | null
} | null> {
  return page.evaluate(async (currentUserId) => {
    const request = indexedDB.open('note-metadata', 1)

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'))
    })

    try {
      const transaction = database.transaction('sync', 'readonly')
      const store = transaction.objectStore('sync')
      const value = await new Promise<unknown>((resolve, reject) => {
        const getRequest = store.get(`${currentUserId}:sync-state`)
        getRequest.onsuccess = () => resolve(getRequest.result)
        getRequest.onerror = () => reject(getRequest.error ?? new Error('Unable to read sync state'))
      })

      if (value === undefined || value === null || typeof value !== 'object') {
        return null
      }

      const syncState = value as {
        files?: unknown
        cursor?: unknown
        lastSyncedAt?: unknown
      }

      return {
        files: Array.isArray(syncState.files) ? syncState.files.filter((file): file is Record<string, unknown> => typeof file === 'object' && file !== null) : [],
        cursor: typeof syncState.cursor === 'number' ? syncState.cursor : 0,
        lastSyncedAt: typeof syncState.lastSyncedAt === 'string' ? syncState.lastSyncedAt : null,
      }
    } finally {
      database.close()
    }
  }, userId)
}

async function createRemoteFileOnServer(request: APIRequestContext, path: string, content: string, userId?: string): Promise<void> {
  const response = await request.post('/api/sync/push', {
    ...withTestUser(userId),
    data: {
      sinceCursor: 0,
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

async function updateRemoteFileOnServer(request: APIRequestContext, path: string, content: string, userId?: string): Promise<void> {
  const remoteFile = await getRemoteFile(request, path, userId)

  expect(remoteFile).not.toBeNull()

  const response = await request.post('/api/sync/push', {
    ...withTestUser(userId),
    data: {
      sinceCursor: 0,
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

async function getSyncSnapshot(request: APIRequestContext, userId?: string): Promise<SyncSnapshotResponse> {
  const response = await request.get('/api/sync/snapshot', withTestUser(userId))
  expect(response.ok()).toBe(true)
  return (await response.json()) as SyncSnapshotResponse
}

async function getRemoteFile(request: APIRequestContext, path: string, userId?: string): Promise<RemoteFile | null> {
  const snapshot = await getSyncSnapshot(request, userId)
  return snapshot.files.find((file) => file.path === path) ?? null
}

async function reloadAndWaitForSync(page: Page): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/sync/push') && response.request().method() === 'POST',
  )

  await page.reload()
  const response = await responsePromise

  expect(response.ok()).toBe(true)
  await waitForSyncIdle(page)
}

async function createNoteFromSidebar(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await page.locator('.tree-row-editor input').fill(name)
  await page.locator('.tree-row-editor input').press('Enter')

  const notePath = `${name}.md`
  const noteButton = page.getByRole('button', { name: notePath, exact: true })

  await expect(noteButton).toBeVisible()
  await expect(noteButton).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, '# Untitled')
  await waitForSyncIdle(page)

  return notePath
}

async function createFolderFromSidebar(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  await page.locator('.tree-row-editor input').fill(name)
  await page.locator('.tree-row-editor input').press('Enter')

  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  await waitForSyncIdle(page)

  return name
}

async function ensureFileIsOpen(page: Page, filePath: string): Promise<void> {
  const fileName = filePath.split('/').pop() ?? filePath
  const noteButton = page.getByRole('button', { name: fileName, exact: true })

  if ((await noteButton.count()) === 0) {
    for (const segment of filePath.split('/').slice(0, -1)) {
      const directoryButton = page.getByRole('button', { name: segment, exact: true })

      await expect(directoryButton).toBeVisible()

      if ((await directoryButton.getAttribute('aria-expanded')) !== 'true') {
        await directoryButton.click()
      }
    }
  }

  await expect(noteButton).toBeVisible()

  if ((await noteButton.getAttribute('aria-current')) !== 'true') {
    await page.locator('.monaco-editor').last().click({ position: { x: 120, y: 24 } })
    await noteButton.click()
  }

  await expect(noteButton).toHaveAttribute('aria-current', 'true')
}

async function enterRenameModeFromFocusedOpenFile(page: Page, fileName: string): Promise<void> {
  const noteButton = page.getByRole('button', { name: fileName, exact: true })

  await ensureFileIsOpen(page, fileName)
  await noteButton.focus()
  await noteButton.click()
  await expect(page.locator('.tree-row-editor input')).toHaveValue(fileName)
}

async function countSyncRequestsDuring(
  page: Page,
  action: () => Promise<void>,
  options: { settleMs?: number } = {},
): Promise<SyncRequestCounts> {
  const counts: SyncRequestCounts = {
    manifest: 0,
    push: 0,
  }
  const settleMs = options.settleMs ?? 700

  const handleRequest = (request: BrowserRequest) => {
    const url = request.url()

    if (url.includes('/api/sync/manifest')) {
      counts.manifest += 1
      return
    }

    if (url.endsWith('/api/sync/push') && request.method() === 'POST') {
      counts.push += 1
    }
  }

  page.on('request', handleRequest)

  try {
    await action()
    await page.waitForTimeout(50)
    await waitForSyncIdle(page)
    await page.waitForTimeout(settleMs)
  } finally {
    page.off('request', handleRequest)
  }

  return counts
}

async function setupSyncedWorkspace(
  page: Page,
  request: APIRequestContext,
  files: Array<{ path: string; content: string }>,
  userId: string,
): Promise<void> {
  await installTestUserHeader(page, userId)
  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  for (const file of files) {
    await writeOpfsFile(page, file.path, file.content)
    await createRemoteFileOnServer(request, file.path, file.content, userId)
    await expect.poll(async () => await readOpfsFile(page, file.path)).toBe(file.content)
    await expect.poll(async () => (await getRemoteFile(request, file.path, userId))?.content ?? null).toBe(file.content)
  }

  await reloadAndWaitForSync(page)
  await expect(page).toHaveTitle('Note')
}

test('auto-syncs exactly once after an editor save', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-save-${runId}`
  const noteName = `save-${runId}`
  const notePath = `${noteName}.md`
  const updatedContent = '# Saved through autosave\n'

  await installTestUserHeader(page, userId)
  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  await createNoteFromSidebar(page, noteName)
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe('# Untitled\n')

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe(updatedContent)
})

test('persists only sync metadata in IndexedDB, not note contents', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-metadata-${runId}`
  const path = `sync-metadata-${runId}/metadata.md`
  const content = '# Metadata only\n'

  await setupSyncedWorkspace(page, request, [{ path, content }], userId)

  const storedSyncState = await readStoredSyncState(page, userId)
  const storedFile = storedSyncState?.files.find((file) => file.path === path)

  expect(storedSyncState?.cursor ?? 0).toBeGreaterThan(0)
  expect(storedSyncState?.lastSyncedAt).not.toBeNull()
  expect(storedFile).toEqual({
    path,
    contentHash: expect.any(String),
    updatedAt: expect.any(String),
    deletedAt: null,
  })
  expect(storedFile).not.toHaveProperty('content')
})

test('keeps the Monaco cursor position stable while autosave and sync run', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-cursor-${runId}`
  const path = `sync-cursor-${runId}/cursor.md`
  const baseContent = '# Header\nFirst paragraph\nTarget line\n'
  const expectedContent = '# Header\nFirst paragraph\n[first][second]Target line\n'

  await setupSyncedWorkspace(page, request, [{ path, content: baseContent }], userId)

  const noteButton = page.getByRole('button', { name: 'cursor.md', exact: true })

  await expect(noteButton).toBeVisible()
  await expect(noteButton).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, 'Target line')

  await focusPlainEditorInput(page)
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')

  const firstSyncRequests = await countSyncRequestsDuring(page, async () => {
    await page.keyboard.insertText('[first]')
  })

  expect(firstSyncRequests).toEqual({ manifest: 0, push: 1 })

  const secondSyncRequests = await countSyncRequestsDuring(page, async () => {
    await page.keyboard.insertText('[second]')
  })

  expect(secondSyncRequests).toEqual({ manifest: 0, push: 1 })
  await expectEditorToContain(page, '[first][second]Target line')
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(expectedContent)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(expectedContent)
})

test('keeps the Monaco cursor column stable within a line while autosave and sync run', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-cursor-column-${runId}`
  const path = `sync-cursor-column-${runId}/cursor-column.md`
  const baseContent = '# Header\nLine before\nAlpha Beta Gamma\n'
  const expectedContent = '# Header\nLine before\nAlpha [first][second]Beta Gamma\n'

  await setupSyncedWorkspace(page, request, [{ path, content: baseContent }], userId)

  const noteButton = page.getByRole('button', { name: 'cursor-column.md', exact: true })

  await expect(noteButton).toBeVisible()
  await expect(noteButton).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, 'Alpha Beta Gamma')

  await focusPlainEditorInput(page)
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')

  for (let step = 0; step < 'Alpha '.length; step += 1) {
    await page.keyboard.press('ArrowRight')
  }

  const firstSyncRequests = await countSyncRequestsDuring(page, async () => {
    await page.keyboard.insertText('[first]')
  })

  expect(firstSyncRequests).toEqual({ manifest: 0, push: 1 })

  const secondSyncRequests = await countSyncRequestsDuring(page, async () => {
    await page.keyboard.insertText('[second]')
  })

  expect(secondSyncRequests).toEqual({ manifest: 0, push: 1 })
  await expectEditorToContain(page, 'Alpha [first][second]Beta Gamma')
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(expectedContent)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(expectedContent)
})

test('keeps the Monaco selection stable while autosave and sync run', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-selection-${runId}`
  const path = `sync-selection-${runId}/selection.md`
  const baseContent = '# Header\nLine before\nAlpha Beta Gamma\n'
  const selectedToken = 'selected '
  const replacementToken = 'replaced '
  const expectedContent = '# Header\nLine before\nAlpha replaced Beta Gamma\n'

  await setupSyncedWorkspace(page, request, [{ path, content: baseContent }], userId)

  const noteButton = page.getByRole('button', { name: 'selection.md', exact: true })

  await expect(noteButton).toBeVisible()
  await expect(noteButton).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, 'Alpha Beta Gamma')

  await focusPlainEditorInput(page)
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')

  for (let step = 0; step < 'Alpha '.length; step += 1) {
    await page.keyboard.press('ArrowRight')
  }

  const firstSyncRequests = await countSyncRequestsDuring(page, async () => {
    await page.keyboard.insertText(selectedToken)

    await page.keyboard.down('Shift')

    for (let step = 0; step < selectedToken.length; step += 1) {
      await page.keyboard.press('ArrowLeft')
    }

    await page.keyboard.up('Shift')
  })

  expect(firstSyncRequests).toEqual({ manifest: 0, push: 1 })

  const secondSyncRequests = await countSyncRequestsDuring(page, async () => {
    await page.keyboard.insertText(replacementToken)
  })

  expect(secondSyncRequests).toEqual({ manifest: 0, push: 1 })
  await expectEditorToContain(page, 'Alpha replaced Beta Gamma')
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(expectedContent)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(expectedContent)
})

test('keeps typing at the same cursor position after a manual keyboard save', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-keyboard-continue-${runId}`
  const path = `sync-keyboard-continue-${runId}/keyboard-continue.md`
  const baseContent = '# Header\nLine before\nAlpha Beta Gamma\n'
  const expectedContent = '# Header\nLine before\nAlpha [first][second]Beta Gamma\n'

  await setupSyncedWorkspace(page, request, [{ path, content: baseContent }], userId)

  const noteButton = page.getByRole('button', { name: 'keyboard-continue.md', exact: true })

  await expect(noteButton).toBeVisible()
  await expect(noteButton).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, 'Alpha Beta Gamma')

  await focusPlainEditorInput(page)
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')

  for (let step = 0; step < 'Alpha '.length; step += 1) {
    await page.keyboard.press('ArrowRight')
  }

  const manualSaveRequests = await countSyncRequestsDuring(page, async () => {
    await page.keyboard.insertText('[first]')
    await page.keyboard.press('ControlOrMeta+S')
  })

  expect(manualSaveRequests).toEqual({ manifest: 0, push: 1 })

  const continuedTypingRequests = await countSyncRequestsDuring(page, async () => {
    await page.keyboard.insertText('[second]')
  })

  expect(continuedTypingRequests).toEqual({ manifest: 0, push: 1 })
  await expectEditorToContain(page, 'Alpha [first][second]Beta Gamma')
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(expectedContent)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(expectedContent)
})

test('keeps typing at the same cursor position after a lifecycle-triggered sync', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-lifecycle-continue-${runId}`
  const path = `sync-lifecycle-continue-${runId}/lifecycle-continue.md`
  const baseContent = '# Header\nLine before\nAlpha Beta Gamma\n'
  const expectedContent = '# Header\nLine before\nAlpha [first][second]Beta Gamma\n'

  await installDateNowHarness(page)
  await setupSyncedWorkspace(page, request, [{ path, content: baseContent }], userId)

  const noteButton = page.getByRole('button', { name: 'lifecycle-continue.md', exact: true })

  await expect(noteButton).toBeVisible()
  await expect(noteButton).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, 'Alpha Beta Gamma')

  await focusPlainEditorInput(page)
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')

  for (let step = 0; step < 'Alpha '.length; step += 1) {
    await page.keyboard.press('ArrowRight')
  }

  await page.keyboard.insertText('[first]')
  await advanceDateNow(page, 11_000)

  const lifecycleSyncRequests = await countSyncRequestsDuring(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
    })
  })

  expect(lifecycleSyncRequests).toEqual({ manifest: 0, push: 1 })

  const continuedTypingRequests = await countSyncRequestsDuring(page, async () => {
    await page.keyboard.insertText('[second]')
  })

  expect(continuedTypingRequests).toEqual({ manifest: 0, push: 1 })
  await expectEditorToContain(page, 'Alpha [first][second]Beta Gamma')
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(expectedContent)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(expectedContent)
})

test('flushes a pending save into the create-note sync without a second push', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-create-${runId}`
  const folder = `sync-create-${runId}`
  const existingPath = `${folder}/before-create.md`
  const updatedContent = '# Saved before creating another note\n'
  const newNoteName = `created-${runId}`
  const newNotePath = `${newNoteName}.md`

  await setupSyncedWorkspace(page, request, [{ path: existingPath, content: '# Before create\n' }], userId)

  const existingNoteButton = page.getByRole('button', { name: 'before-create.md', exact: true })

  await expect(existingNoteButton).toBeVisible()
  await expect(existingNoteButton).toHaveAttribute('aria-current', 'true')

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
    await page.getByRole('button', { name: 'New note', exact: true }).click()
    await page.locator('.tree-row-editor input').fill(newNoteName)
    await page.locator('.tree-row-editor input').press('Enter')
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, existingPath, userId))?.content ?? null).toBe(updatedContent)
  await expect.poll(async () => (await getRemoteFile(request, newNotePath, userId))?.content ?? null).toBe('# Untitled\n')
})

test('flushes a pending save into the rename sync without a second push', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-rename-${runId}`
  const folder = `sync-rename-${runId}`
  const originalPath = `${folder}/before-rename.md`
  const renamedName = `after-${runId}.md`
  const renamedPath = `${folder}/${renamedName}`
  const updatedContent = '# Saved before rename\n'

  await setupSyncedWorkspace(page, request, [{ path: originalPath, content: '# Before rename\n' }], userId)

  const originalNoteButton = page.getByRole('button', { name: 'before-rename.md', exact: true })

  await expect(originalNoteButton).toBeVisible()
  await expect(originalNoteButton).toHaveAttribute('aria-current', 'true')

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
    await originalNoteButton.focus()
    await page.getByRole('button', { name: `Rename ${originalPath}`, exact: true }).click()
    await page.locator('.tree-row-editor input').fill(renamedName)
    await page.locator('.tree-row-editor input').press('Enter')
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, renamedPath, userId))?.content ?? null).toBe(updatedContent)
  await expect.poll(async () => (await getRemoteFile(request, originalPath, userId))?.deletedAt ?? null).not.toBeNull()
})

test('flushes a pending save into the delete sync without a second push', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-delete-${runId}`
  const folder = `sync-delete-${runId}`
  const openPath = `${folder}/keep-open.md`
  const deletedPath = `${folder}/delete-me.md`
  const updatedContent = '# Saved before deleting sibling\n'

  await setupSyncedWorkspace(
    page,
    request,
    [
      { path: deletedPath, content: '# Delete me\n' },
      { path: openPath, content: '# Keep me\n' },
    ],
    userId,
  )

  const openNoteButton = page.getByRole('button', { name: 'keep-open.md', exact: true })
  const deletedNoteButton = page.getByRole('button', { name: 'delete-me.md', exact: true })

  await expect(openNoteButton).toBeVisible()

  if ((await openNoteButton.getAttribute('aria-current')) !== 'true') {
    await page.locator('.monaco-editor').last().click({ position: { x: 120, y: 24 } })
    await openNoteButton.click()
  }

  await expect(openNoteButton).toHaveAttribute('aria-current', 'true')

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toBe(`Delete ${deletedPath}?`)
      await dialog.accept()
    })
    await deletedNoteButton.focus()
    await page.getByRole('button', { name: `Delete ${deletedPath}`, exact: true }).click()
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, openPath, userId))?.content ?? null).toBe(updatedContent)
  await expect.poll(async () => (await getRemoteFile(request, deletedPath, userId))?.deletedAt ?? null).not.toBeNull()
})

test('flushes a pending save into the create-folder sync without a second push', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-create-folder-${runId}`
  const existingPath = `sync-create-folder-${runId}/before-folder.md`
  const updatedContent = '# Saved before creating a folder\n'
  const folderName = `created-folder-${runId}`

  await setupSyncedWorkspace(page, request, [{ path: existingPath, content: '# Before folder create\n' }], userId)

  const existingNoteButton = page.getByRole('button', { name: 'before-folder.md', exact: true })

  await expect(existingNoteButton).toBeVisible()
  await expect(existingNoteButton).toHaveAttribute('aria-current', 'true')

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
    await createFolderFromSidebar(page, folderName)
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, existingPath, userId))?.content ?? null).toBe(updatedContent)
  await expect(page.getByRole('button', { name: folderName, exact: true })).toBeVisible()
})

test('blocks create note, create folder, rename, and delete when flushPendingSave hits a local conflict', async ({ browser, request }) => {
  async function runScenario(options: {
    label: string
    files: Array<{ path: string; content: string }>
    openPath: string
    diskContent: string
    localDraft: string
    action(page: Page): Promise<void>
    assertBlocked(page: Page, userId: string): Promise<void>
  }) {
    const userId = `sync-action-conflict-${options.label}-${randomUUID()}`
    const page = await createIsolatedBrowserPage(browser, userId)
    const openFile = options.files.find((file) => file.path === options.openPath)

    if (openFile === undefined) {
      throw new Error(`Missing open file fixture for ${options.openPath}`)
    }

    try {
      await setupSyncedWorkspace(page, request, options.files, userId)
      await ensureFileIsOpen(page, options.openPath)
      await expectEditorToContain(page, openFile.content.trim())

      await writeOpfsFile(page, options.openPath, options.diskContent)
      await expect.poll(async () => await readOpfsFile(page, options.openPath)).toBe(options.diskContent)

      const syncRequests = await countSyncRequestsDuring(page, async () => {
        await replaceEditorContent(page, options.localDraft)
        await options.action(page)
      })

      expect(syncRequests).toEqual({ manifest: 0, push: 0 })
      await expect(page.getByRole('button', { name: new RegExp(`File conflict: ${RegExp.escape(options.openPath)}`) })).toBeVisible()
      await expect.poll(async () => await readOpfsFile(page, options.openPath)).toBe(options.diskContent)
      await expect.poll(async () => (await getRemoteFile(request, options.openPath, userId))?.content ?? null).toBe(openFile.content)
      await options.assertBlocked(page, userId)
    } finally {
      await page.context().close()
    }
  }

  await runScenario({
    label: 'create-note',
    files: [{ path: 'sync-action-conflict/create-note/open.md', content: '# Base create note\n' }],
    openPath: 'sync-action-conflict/create-note/open.md',
    diskContent: '# Disk changed before create note\n',
    localDraft: '# Local draft before create note\n',
    async action(page) {
      await page.getByRole('button', { name: 'New note', exact: true }).click()
      await page.locator('.tree-row-editor input').fill('blocked-note')
      await page.locator('.tree-row-editor input').press('Enter')
    },
    async assertBlocked(page) {
      await expect(page.getByRole('button', { name: 'blocked-note.md', exact: true })).toHaveCount(0)
    },
  })

  await runScenario({
    label: 'create-folder',
    files: [{ path: 'sync-action-conflict/create-folder/open.md', content: '# Base create folder\n' }],
    openPath: 'sync-action-conflict/create-folder/open.md',
    diskContent: '# Disk changed before create folder\n',
    localDraft: '# Local draft before create folder\n',
    async action(page) {
      await page.getByRole('button', { name: 'New folder', exact: true }).click()
      await page.locator('.tree-row-editor input').fill('blocked-folder')
      await page.locator('.tree-row-editor input').press('Enter')
    },
    async assertBlocked(page) {
      await expect(page.getByRole('button', { name: 'blocked-folder', exact: true })).toHaveCount(0)
    },
  })

  await runScenario({
    label: 'rename',
    files: [{ path: 'sync-action-conflict/rename/open.md', content: '# Base rename\n' }],
    openPath: 'sync-action-conflict/rename/open.md',
    diskContent: '# Disk changed before rename\n',
    localDraft: '# Local draft before rename\n',
    async action(page) {
      const noteButton = page.getByRole('button', { name: 'open.md', exact: true })

      await noteButton.focus()
      await page.getByRole('button', { name: 'Rename sync-action-conflict/rename/open.md', exact: true }).click()
      await page.locator('.tree-row-editor input').fill('renamed.md')
      await page.locator('.tree-row-editor input').press('Enter')
    },
    async assertBlocked(page) {
      await expect(page.locator('.tree-row-editor input')).toHaveValue('renamed.md')
      await expect(page.getByRole('button', { name: 'open.md', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'renamed.md', exact: true })).toHaveCount(0)
    },
  })

  await runScenario({
    label: 'delete',
    files: [
      { path: 'sync-action-conflict/delete/open.md', content: '# Base delete open\n' },
      { path: 'sync-action-conflict/delete/keep.md', content: '# Keep sibling\n' },
    ],
    openPath: 'sync-action-conflict/delete/open.md',
    diskContent: '# Disk changed before delete\n',
    localDraft: '# Local draft before delete\n',
    async action(page) {
      let sawDialog = false
      const dialogListener = async (dialog: Dialog) => {
        sawDialog = true
        await dialog.dismiss()
      }

      page.on('dialog', dialogListener)

      try {
        await page.getByRole('button', { name: 'keep.md', exact: true }).focus()
        await page.getByRole('button', { name: 'Delete sync-action-conflict/delete/keep.md', exact: true }).click()
      } finally {
        page.off('dialog', dialogListener)
      }

      expect(sawDialog).toBe(false)
    },
    async assertBlocked(page, userId) {
      await expect(page.getByRole('button', { name: 'keep.md', exact: true })).toBeVisible()
      await expect.poll(async () => (await getRemoteFile(request, 'sync-action-conflict/delete/keep.md', userId))?.content ?? null).toBe(
        '# Keep sibling\n',
      )
    },
  })
})

test('still syncs a flushed save when create and rename attempts fail validation or hit duplicates', async ({ browser, request }) => {
  async function runScenario(options: {
    label: string
    files: Array<{ path: string; content: string }>
    openPath: string
    localDraft: string
    action(page: Page): Promise<void>
    expectedAlert?: string
    assertFailedMutation(page: Page): Promise<void>
  }) {
    const userId = `sync-failed-mutation-${options.label}-${randomUUID()}`
    const page = await createIsolatedBrowserPage(browser, userId)

    try {
      await setupSyncedWorkspace(page, request, options.files, userId)
      await ensureFileIsOpen(page, options.openPath)

      const syncRequests = await countSyncRequestsDuring(page, async () => {
        await replaceEditorContent(page, options.localDraft)
        await options.action(page)
      })

      expect(syncRequests).toEqual({ manifest: 0, push: 1 })
      await expect.poll(async () => (await getRemoteFile(request, options.openPath, userId))?.content ?? null).toBe(options.localDraft)

      if (options.expectedAlert !== undefined) {
        await expect(page.locator('.tree-row-editor [role="alert"]')).toHaveText(options.expectedAlert)
      }

      await options.assertFailedMutation(page)
    } finally {
      await page.context().close()
    }
  }

  await runScenario({
    label: 'invalid-create-note',
    files: [{ path: 'sync-failed-mutation/invalid-create-note/open.md', content: '# Base invalid create note\n' }],
    openPath: 'sync-failed-mutation/invalid-create-note/open.md',
    localDraft: '# Saved before invalid create note\n',
    async action(page) {
      await page.getByRole('button', { name: 'New note', exact: true }).click()
      await page.locator('.tree-row-editor input').fill('/bad')
      await page.locator('.tree-row-editor input').press('Enter')
    },
    expectedAlert: 'Enter a valid note path.',
    async assertFailedMutation(page) {
      await expect(page.locator('.tree-row-editor input')).toHaveValue('/bad')
      await expect(page.getByRole('button', { name: 'bad.md', exact: true })).toHaveCount(0)
    },
  })

  await runScenario({
    label: 'duplicate-create-folder',
    files: [
      { path: 'sync-failed-mutation/duplicate-create-folder/open.md', content: '# Base duplicate create folder\n' },
      { path: 'taken-folder/existing.md', content: '# Existing folder file\n' },
    ],
    openPath: 'sync-failed-mutation/duplicate-create-folder/open.md',
    localDraft: '# Saved before duplicate create folder\n',
    async action(page) {
      await page.getByRole('button', { name: 'New folder', exact: true }).click()
      await page.locator('.tree-row-editor input').fill('taken-folder')
      await page.locator('.tree-row-editor input').press('Enter')
    },
    expectedAlert: 'An entry named "taken-folder" already exists here.',
    async assertFailedMutation(page) {
      await expect(page.locator('.tree-row-editor input')).toHaveValue('taken-folder')
      await expect(page.getByRole('button', { name: 'taken-folder', exact: true })).toBeVisible()
    },
  })

  await runScenario({
    label: 'invalid-rename-note',
    files: [{ path: 'sync-failed-mutation/invalid-rename-note/open.md', content: '# Base invalid rename\n' }],
    openPath: 'sync-failed-mutation/invalid-rename-note/open.md',
    localDraft: '# Saved before invalid rename\n',
    async action(page) {
      await enterRenameModeFromFocusedOpenFile(page, 'open.md')
      await page.locator('.tree-row-editor input').fill('bad/name.md')
      await page.locator('.tree-row-editor input').press('Enter')
    },
    async assertFailedMutation(page) {
      await expect(page.locator('.tree-row-editor input')).toHaveValue('bad/name.md')
      await expect(page.getByRole('button', { name: 'bad/name.md', exact: true })).toHaveCount(0)
    },
  })

  await runScenario({
    label: 'duplicate-rename-note',
    files: [
      { path: 'sync-failed-mutation/duplicate-rename-note/open.md', content: '# Base duplicate rename\n' },
      { path: 'sync-failed-mutation/duplicate-rename-note/taken.md', content: '# Existing taken note\n' },
    ],
    openPath: 'sync-failed-mutation/duplicate-rename-note/open.md',
    localDraft: '# Saved before duplicate rename\n',
    async action(page) {
      await enterRenameModeFromFocusedOpenFile(page, 'open.md')
      await page.locator('.tree-row-editor input').fill('taken.md')
      await page.locator('.tree-row-editor input').press('Enter')
    },
    async assertFailedMutation(page) {
      await expect(page.locator('.tree-row-editor input')).toHaveValue('taken.md')
      await expect(page.getByRole('button', { name: 'taken.md', exact: true })).toBeVisible()
    },
  })
})

test('still syncs a flushed save when renaming a note to the same name', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-same-name-rename-${runId}`
  const path = `sync-same-name-rename-${runId}/open.md`
  const updatedContent = '# Saved before same-name rename\n'

  await setupSyncedWorkspace(page, request, [{ path, content: '# Base same-name rename\n' }], userId)
  await ensureFileIsOpen(page, path)

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
    await enterRenameModeFromFocusedOpenFile(page, 'open.md')
    await page.locator('.tree-row-editor input').press('Enter')
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(updatedContent)
  await expect(page.getByRole('button', { name: 'open.md', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.tree-row-editor input')).toHaveCount(0)
})

test('still syncs a flushed save when delete is cancelled', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-cancel-delete-${runId}`
  const openPath = `sync-cancel-delete-${runId}/open.md`
  const keptPath = `sync-cancel-delete-${runId}/keep.md`
  const updatedContent = '# Saved before cancelling delete\n'

  await setupSyncedWorkspace(
    page,
    request,
    [
      { path: openPath, content: '# Base open\n' },
      { path: keptPath, content: '# Keep me\n' },
    ],
    userId,
  )
  await ensureFileIsOpen(page, openPath)

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toBe(`Delete ${keptPath}?`)
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: 'keep.md', exact: true }).focus()
    await page.getByRole('button', { name: `Delete ${keptPath}`, exact: true }).click()
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, openPath, userId))?.content ?? null).toBe(updatedContent)
  await expect.poll(async () => (await getRemoteFile(request, keptPath, userId))?.content ?? null).toBe('# Keep me\n')
  await expect(page.getByRole('button', { name: 'keep.md', exact: true })).toBeVisible()
  await expect.poll(async () => await readOpfsFile(page, keptPath)).toBe('# Keep me\n')
})

test('syncs exactly once when saving with the keyboard shortcut', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-keyboard-save-${runId}`
  const noteName = `keyboard-save-${runId}`
  const notePath = `${noteName}.md`
  const updatedContent = '# Saved with keyboard shortcut\n'

  await installTestUserHeader(page, userId)
  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  await createNoteFromSidebar(page, noteName)
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe('# Untitled\n')

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
    await page.keyboard.press('ControlOrMeta+S')
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe(updatedContent)
})

test('syncs exactly once when saving with the global keyboard shortcut outside Monaco', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-global-save-${runId}`
  const noteName = `global-save-${runId}`
  const notePath = `${noteName}.md`
  const updatedContent = '# Saved from the global shortcut\n'

  await installTestUserHeader(page, userId)
  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  await createNoteFromSidebar(page, noteName)
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe('# Untitled\n')

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
    await page.getByRole('button', { name: /^Sync/ }).focus()
    await page.keyboard.press('ControlOrMeta+S')
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe(updatedContent)
})

test('syncs exactly once when using the manual sync keyboard shortcut', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-manual-hotkey-${runId}`
  const noteName = `manual-hotkey-${runId}`
  const notePath = `${noteName}.md`

  await installTestUserHeader(page, userId)
  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  await createNoteFromSidebar(page, noteName)

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await page.getByRole('button', { name: /^Sync/ }).focus()
    await page.keyboard.press('ControlOrMeta+Shift+S')
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe('# Untitled\n')
})

test('does not sync when a pending autosave hits a local file conflict', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-conflict-${runId}`
  const path = `sync-conflict-${runId}/file-conflict.md`
  const baseContent = '# Base version\n'
  const diskContent = '# Disk changed behind the editor\n'
  const localDraft = '# Local draft that should conflict\n'

  await setupSyncedWorkspace(page, request, [{ path, content: baseContent }], userId)

  const noteButton = page.getByRole('button', { name: 'file-conflict.md', exact: true })

  await expect(noteButton).toBeVisible()
  await expect(noteButton).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, '# Base version')

  await writeOpfsFile(page, path, diskContent)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(diskContent)

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, localDraft)
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 0 })
  await expect(page.getByRole('button', { name: new RegExp(`File conflict: ${RegExp.escape(path)}`) })).toBeVisible()
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(diskContent)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(baseContent)
})

test('does not surface a local file conflict when an older in-flight sync finishes after a newer autosave', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-race-${runId}`
  const path = `sync-race-${runId}/typing.md`
  const baseContent = '# Base version\n'
  const firstDraft = '# First saved draft\n'
  const finalDraft = '# Final draft after slow sync\n'

  await setupSyncedWorkspace(page, request, [{ path, content: baseContent }], userId)

  let delayedPushCount = 0

  await page.route('**/api/sync/push', async (route) => {
    delayedPushCount += 1

    if (delayedPushCount === 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 800)
      })
    }

    await route.continue()
  })

  const syncRequests = await countSyncRequestsDuring(
    page,
    async () => {
      await replaceEditorContent(page, firstDraft)
      await page.waitForTimeout(450)
      await replaceEditorContent(page, finalDraft)
      await page.waitForTimeout(450)
    },
    { settleMs: 1_000 },
  )

  expect(syncRequests).toEqual({ manifest: 0, push: 2 })
  await expect(page.getByRole('button', { name: /File conflict:/ })).toHaveCount(0)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(finalDraft)
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(finalDraft)
  await expectEditorToContain(page, '# Final draft after slow sync')
})

test('keeps workspace changes dirty until a full sync succeeds, then falls back to manifest prechecks', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-dirty-${runId}`
  const noteName = `dirty-${runId}`
  const notePath = `${noteName}.md`
  const updatedContent = '# Dirty until a full sync succeeds\n'
  let remainingPushFailures = 1

  await installDateNowHarness(page)
  await installTestUserHeader(page, userId)
  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  await createNoteFromSidebar(page, noteName)
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe('# Untitled\n')

  await page.route('**/api/sync/push', async (route) => {
    if (remainingPushFailures > 0) {
      remainingPushFailures -= 1
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Forced sync failure' }),
      })
      return
    }

    await route.continue()
  })

  const failedSyncRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
  })

  expect(failedSyncRequests).toEqual({ manifest: 0, push: 1 })
  await expect(page.locator('.statusbar-message')).toHaveText('Request failed with 500')
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe('# Untitled\n')

  await advanceDateNow(page, 11_000)

  const lifecycleFullSyncRequests = await countSyncRequestsDuring(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
    })
  })

  expect(lifecycleFullSyncRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, notePath, userId))?.content ?? null).toBe(updatedContent)

  await advanceDateNow(page, 11_000)

  const lifecyclePrecheckRequests = await countSyncRequestsDuring(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
    })
  })

  expect(lifecyclePrecheckRequests).toEqual({ manifest: 1, push: 0 })
})

test('pulls remote changes during the startup full sync after reloading', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-startup-${runId}`
  const path = `sync-startup-${runId}/startup.md`
  const baseContent = '# Before startup reload\n'
  const remoteContent = '# Pulled on startup reload\n'

  await setupSyncedWorkspace(page, request, [{ path, content: baseContent }], userId)
  await updateRemoteFileOnServer(request, path, remoteContent, userId)

  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(remoteContent)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(baseContent)

  await reloadAndWaitForSync(page)

  await expect.poll(async () => await readOpfsFile(page, path)).toBe(remoteContent)
  await expectEditorToContain(page, '# Pulled on startup reload')
})

test('does not immediately schedule another lifecycle sync right after startup sync completes', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-startup-dedupe-${runId}`

  await setupSyncedWorkspace(page, request, [{ path: `sync-startup-dedupe-${runId}/open.md`, content: '# Startup dedupe\n' }], userId)

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
    })
  })

  expect(syncRequests).toEqual({ manifest: 0, push: 0 })
})

test('only prechecks on visibility change when the page becomes visible', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-visibility-${runId}`

  await installDateNowHarness(page)
  await installVisibilityStateHarness(page)
  await setupSyncedWorkspace(page, request, [{ path: `sync-visibility-${runId}/open.md`, content: '# Visibility sync\n' }], userId)

  await advanceDateNow(page, 11_000)

  const hiddenRequests = await countSyncRequestsDuring(page, async () => {
    await dispatchVisibilityChange(page, 'hidden')
  })

  expect(hiddenRequests).toEqual({ manifest: 0, push: 0 })

  await advanceDateNow(page, 11_000)

  const visibleRequests = await countSyncRequestsDuring(page, async () => {
    await dispatchVisibilityChange(page, 'visible')
  })

  expect(visibleRequests).toEqual({ manifest: 1, push: 0 })
})

test('ignores focus and online auto-sync triggers while the page is hidden', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-hidden-lifecycle-${runId}`

  await installVisibilityStateHarness(page)
  await setupSyncedWorkspace(page, request, [{ path: `sync-hidden-lifecycle-${runId}/open.md`, content: '# Hidden lifecycle\n' }], userId)
  await setVisibilityState(page, 'hidden')

  const hiddenRequests = await countSyncRequestsDuring(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
    })
  })

  expect(hiddenRequests).toEqual({ manifest: 0, push: 0 })
})

test('uses a manifest precheck when coming online clean and a full sync when local changes are pending', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-online-${runId}`
  const path = `sync-online-${runId}/online.md`
  const updatedContent = '# Synced after reconnecting online\n'

  await installDateNowHarness(page)
  await setupSyncedWorkspace(page, request, [{ path, content: '# Online base\n' }], userId)

  await advanceDateNow(page, 11_000)

  const cleanRequests = await countSyncRequestsDuring(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'))
    })
  })

  expect(cleanRequests).toEqual({ manifest: 1, push: 0 })

  await advanceDateNow(page, 11_000)

  const dirtyRequests = await countSyncRequestsDuring(page, async () => {
    await replaceEditorContent(page, updatedContent)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'))
    })
  })

  expect(dirtyRequests).toEqual({ manifest: 0, push: 1 })
  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(updatedContent)
})

test('pulls remote changes during a clean lifecycle precheck when the manifest differs', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-lifecycle-manifest-fallback-${runId}`
  const path = `sync-lifecycle-manifest-fallback-${runId}/fallback.md`
  const baseContent = '# Before lifecycle mismatch\n'
  const remoteContent = '# Pulled after lifecycle mismatch\n'

  await installDateNowHarness(page)
  await setupSyncedWorkspace(page, request, [{ path, content: baseContent }], userId)
  await updateRemoteFileOnServer(request, path, remoteContent, userId)

  await expect.poll(async () => (await getRemoteFile(request, path, userId))?.content ?? null).toBe(remoteContent)
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(baseContent)

  await advanceDateNow(page, 11_000)

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
    })
  })

  expect(syncRequests).toEqual({ manifest: 1, push: 0 })
  await expect.poll(async () => await readOpfsFile(page, path)).toBe(remoteContent)
  await expectEditorToContain(page, '# Pulled after lifecycle mismatch')
})

test('polls only while visible and falls back to manifest prechecks when clean', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-poll-${runId}`

  await installDateNowHarness(page)
  await installVisibilityStateHarness(page)
  await installPollingHarness(page)
  await setupSyncedWorkspace(page, request, [{ path: `sync-poll-${runId}/poll.md`, content: '# Polling sync\n' }], userId)

  await setVisibilityState(page, 'hidden')
  await advanceDateNow(page, 11_000)

  const hiddenPollRequests = await countSyncRequestsDuring(
    page,
    async () => {
      await page.waitForTimeout(80)
    },
    { settleMs: 120 },
  )

  expect(hiddenPollRequests).toEqual({ manifest: 0, push: 0 })

  await setVisibilityState(page, 'visible')
  await advanceDateNow(page, 11_000)

  const visiblePollRequests = await countSyncRequestsDuring(
    page,
    async () => {
      await page.waitForTimeout(80)
    },
    { settleMs: 120 },
  )

  expect(visiblePollRequests).toEqual({ manifest: 1, push: 0 })
})

test('dedupes back-to-back lifecycle auto-sync triggers within the cooldown window', async ({ page, request }) => {
  const runId = randomUUID()
  const userId = `sync-cooldown-${runId}`

  await installDateNowHarness(page)
  await setupSyncedWorkspace(page, request, [{ path: `sync-cooldown-${runId}/cooldown.md`, content: '# Cooldown sync\n' }], userId)

  await advanceDateNow(page, 11_000)

  const syncRequests = await countSyncRequestsDuring(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
  })

  expect(syncRequests).toEqual({ manifest: 1, push: 0 })
})
