import { randomUUID } from 'node:crypto'
import { expect, test, type Browser, type Page } from '@playwright/test'

type FakeDirectoryConfig = {
  appOpfsRootName: string
  pickedFolderName: string
  pickerBehavior?: 'handle' | 'abort' | 'unsupported'
  queryPermission: PermissionState
  requestPermission: PermissionState
}

type SeededNotePaths = {
  alphaPath: string
  betaPath: string
}

const TEST_CONFIG_KEY = '__note_storage_browser_test_config__'
const TEST_USER_HEADER = 'X-Note-User'

async function installTestUserHeader(page: Page, userId: string): Promise<void> {
  await page.context().addInitScript(
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

async function createIsolatedStoragePage(browser: Browser, userId: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL ?? 'http://127.0.0.1:4173',
    extraHTTPHeaders: {
      [TEST_USER_HEADER]: userId,
    },
  })

  return context.newPage()
}

async function installDateNowHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let mockedNow = Date.now()

    Object.defineProperty(window, '__noteStorageBrowserTestClock', {
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

async function advanceDateNow(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((delta) => {
    ;(window as unknown as Window & {
      __noteStorageBrowserTestClock: {
        advanceBy(milliseconds: number): void
      }
    }).__noteStorageBrowserTestClock.advanceBy(delta)
  }, milliseconds)
}

async function installStorageHarness(page: Page, initialConfig: FakeDirectoryConfig): Promise<void> {
  await page.addInitScript(
    ({ configKey, initial }) => {
      type InitConfig = {
        appOpfsRootName: string
        pickedFolderName: string
        pickerBehavior?: 'handle' | 'abort' | 'unsupported'
        queryPermission: PermissionState
        requestPermission: PermissionState
      }

      const session = window.sessionStorage

      function readConfig(): InitConfig {
        const raw = session.getItem(configKey)
        return raw === null ? initial : (JSON.parse(raw) as InitConfig)
      }

      function writeConfig(nextConfig: InitConfig): void {
        session.setItem(configKey, JSON.stringify(nextConfig))
      }

      if (session.getItem(configKey) === null) {
        writeConfig(initial)
      }

      const originalGetDirectory = navigator.storage.getDirectory.bind(navigator.storage)

      Object.defineProperty(globalThis, '__noteStorageBrowserTest', {
        configurable: true,
        value: {
          readConfig,
          writeConfig,
          async getPickedDirectoryHandle() {
            const root = await originalGetDirectory()
            return root.getDirectoryHandle(readConfig().pickedFolderName, { create: true })
          },
          async getRealRootDirectoryHandle() {
            return originalGetDirectory()
          },
        },
      })

      Object.defineProperty(navigator.storage, 'getDirectory', {
        configurable: true,
        value: async () => {
          const root = await originalGetDirectory()
          return root.getDirectoryHandle(readConfig().appOpfsRootName, { create: true })
        },
      })

      if (readConfig().pickerBehavior === 'unsupported') {
        Object.defineProperty(window, 'showDirectoryPicker', {
          configurable: true,
          value: undefined,
        })
      } else {
        Object.defineProperty(window, 'showDirectoryPicker', {
          configurable: true,
          value: async () => {
            if (readConfig().pickerBehavior === 'abort') {
              throw new DOMException('The user aborted a request.', 'AbortError')
            }

            const root = await originalGetDirectory()
            return root.getDirectoryHandle(readConfig().pickedFolderName, { create: true })
          },
        })
      }

      if ('FileSystemDirectoryHandle' in globalThis) {
        const directoryHandlePrototype = FileSystemDirectoryHandle.prototype as FileSystemDirectoryHandle & {
          __noteStorageBrowserTestPatched?: boolean
        }

        if (directoryHandlePrototype.__noteStorageBrowserTestPatched !== true) {
          const originalQueryPermission = directoryHandlePrototype.queryPermission
          const originalRequestPermission = directoryHandlePrototype.requestPermission

          directoryHandlePrototype.queryPermission = async function (descriptor) {
            const config = readConfig()

            if (this.name === config.pickedFolderName) {
              return config.queryPermission
            }

            return originalQueryPermission.call(this, descriptor)
          }

          directoryHandlePrototype.requestPermission = async function (descriptor) {
            const config = readConfig()

            if (this.name === config.pickedFolderName) {
              const nextPermission = config.requestPermission

              writeConfig({
                ...config,
                queryPermission: nextPermission,
              })

              return nextPermission
            }

            return originalRequestPermission.call(this, descriptor)
          }

          directoryHandlePrototype.__noteStorageBrowserTestPatched = true
        }
      }
    },
    { configKey: TEST_CONFIG_KEY, initial: initialConfig },
  )
}

async function writePickedFolderFiles(
  page: Page,
  files: Array<{
    path: string
    content: string
  }>,
): Promise<void> {
  await page.evaluate(async (entries) => {
    const testApi = (globalThis as unknown as {
      __noteStorageBrowserTest: {
        getPickedDirectoryHandle(): Promise<FileSystemDirectoryHandle>
      }
    }).__noteStorageBrowserTest

    async function getDirectoryHandleAtPath(
      root: FileSystemDirectoryHandle,
      path: string,
    ): Promise<FileSystemDirectoryHandle> {
      let current = root

      for (const segment of path.split('/').filter((part) => part.length > 0)) {
        current = await current.getDirectoryHandle(segment, { create: true })
      }

      return current
    }

    for (const entry of entries) {
      const segments = entry.path.split('/').filter((part) => part.length > 0)
      const name = segments.pop()

      if (name === undefined) {
        throw new Error('Expected a file path to seed the picked folder')
      }

      const directory = await getDirectoryHandleAtPath(await testApi.getPickedDirectoryHandle(), segments.join('/'))
      const fileHandle = await directory.getFileHandle(name, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(entry.content)
      await writable.close()
    }
  }, files)
}

async function readPickedFolderFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (targetPath) => {
    const testApi = (globalThis as unknown as {
      __noteStorageBrowserTest: {
        getPickedDirectoryHandle(): Promise<FileSystemDirectoryHandle>
      }
    }).__noteStorageBrowserTest

    const segments = targetPath.split('/').filter((part) => part.length > 0)
    const name = segments.pop()

    if (name === undefined) {
      return null
    }

    let directory = await testApi.getPickedDirectoryHandle()

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

async function readOpfsFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (targetPath) => {
    const root = await navigator.storage.getDirectory()
    const segments = targetPath.split('/').filter((part) => part.length > 0)
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

async function deletePickedFolderEntry(page: Page, path: string): Promise<void> {
  await page.evaluate(async (targetPath) => {
    const testApi = (globalThis as unknown as {
      __noteStorageBrowserTest: {
        getPickedDirectoryHandle(): Promise<FileSystemDirectoryHandle>
      }
    }).__noteStorageBrowserTest

    const segments = targetPath.split('/').filter((part) => part.length > 0)
    const name = segments.pop()

    if (name === undefined) {
      return
    }

    let directory = await testApi.getPickedDirectoryHandle()

    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment)
    }

    await directory.removeEntry(name, { recursive: true })
  }, path)
}

async function readStoredAppSettings(page: Page): Promise<{ backend: string; lastOpenedPath: string | null } | null> {
  return page.evaluate(async () => {
    const request = indexedDB.open('note-metadata', 1)

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'))
    })

    try {
      const transaction = database.transaction('settings', 'readonly')
      const store = transaction.objectStore('settings')
      const value = await new Promise<unknown>((resolve, reject) => {
        const getRequest = store.get('app-settings')
        getRequest.onsuccess = () => resolve(getRequest.result)
        getRequest.onerror = () => reject(getRequest.error ?? new Error('Unable to read app settings'))
      })

      if (value === undefined || value === null || typeof value !== 'object') {
        return null
      }

      const settings = value as { backend?: unknown; lastOpenedPath?: unknown }

      return {
        backend: typeof settings.backend === 'string' ? settings.backend : 'opfs',
        lastOpenedPath: typeof settings.lastOpenedPath === 'string' ? settings.lastOpenedPath : null,
      }
    } finally {
      database.close()
    }
  })
}

async function updateStoredAppSettings(
  page: Page,
  updates: Partial<{
    backend: string
    lastOpenedPath: string | null
  }>,
): Promise<void> {
  await page.evaluate(async (nextUpdates) => {
    const request = indexedDB.open('note-metadata', 1)

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'))
    })

    try {
      const transaction = database.transaction('settings', 'readwrite')
      const store = transaction.objectStore('settings')
      const currentValue = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const getRequest = store.get('app-settings')
        getRequest.onsuccess = () => resolve((getRequest.result as Record<string, unknown> | undefined) ?? {})
        getRequest.onerror = () => reject(getRequest.error ?? new Error('Unable to read app settings'))
      })

      await new Promise<void>((resolve, reject) => {
        const putRequest = store.put(
          {
            ...currentValue,
            ...nextUpdates,
          },
          'app-settings',
        )
        putRequest.onsuccess = () => resolve()
        putRequest.onerror = () => reject(putRequest.error ?? new Error('Unable to write app settings'))
      })
    } finally {
      database.close()
    }
  }, updates)
}

async function waitForStorageLabelToSettle(page: Page): Promise<void> {
  const storageButton = page.locator('.statusbar-storage > .statusbar-button')

  await expect(storageButton).toBeVisible()
  await expect.poll(async () => (await storageButton.textContent())?.trim() ?? '').not.toBe('Loading...')
}

async function waitForSyncIdle(page: Page): Promise<void> {
  await waitForStorageLabelToSettle(page)

  const syncButton = page.getByRole('button', { name: /^Sync/ })
  await expect(syncButton).toBeVisible()
  await expect.poll(async () => await syncButton.getAttribute('aria-busy')).not.toBe('true')
}

async function expectEditorToContain(page: Page, text: string): Promise<void> {
  await expect(page.locator('.monaco-editor .view-lines').last()).toContainText(text)
}

async function replaceEditorContent(page: Page, content: string): Promise<void> {
  const editor = page.locator('.monaco-editor').last()
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

async function waitForNextSyncPush(page: Page): Promise<void> {
  const response = await page.waitForResponse(
    (candidate) => candidate.url().endsWith('/api/sync/push') && candidate.request().method() === 'POST',
  )

  expect(response.ok()).toBe(true)
}

async function reopenAppWithHarness(page: Page, config: FakeDirectoryConfig): Promise<Page> {
  const nextPage = await page.context().newPage()
  await installStorageHarness(nextPage, config)
  await page.close()
  await nextPage.goto('/')
  await expect(nextPage).toHaveTitle('Note')
  await waitForStorageLabelToSettle(nextPage)
  return nextPage
}

async function attachPickedFolder(
  page: Page,
  files: Array<{
    path: string
    content: string
  }> = [],
): Promise<void> {
  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  const pickedFolderName = await page.evaluate(() => {
    const testApi = (globalThis as unknown as {
      __noteStorageBrowserTest: {
        readConfig(): { pickedFolderName: string }
      }
    }).__noteStorageBrowserTest

    return testApi.readConfig().pickedFolderName
  })

  if (files.length > 0) {
    await writePickedFolderFiles(page, files)
  }

  await page.getByRole('button', { name: 'OPFS', exact: true }).click()
  await page.getByRole('button', { name: 'Attach folder' }).click()
  await expect(page.locator('.statusbar-storage').getByRole('button', { name: pickedFolderName, exact: true })).toBeVisible()
  await waitForSyncIdle(page)
}

async function attachPickedFolderAndOpenLastNote(page: Page, paths: SeededNotePaths): Promise<void> {
  await attachPickedFolder(page, [
    { path: paths.alphaPath, content: '# Alpha note\n' },
    { path: paths.betaPath, content: '# Beta note\n' },
  ])

  const betaButton = page.getByRole('button', { name: 'beta.md', exact: true })

  await expect(betaButton).toBeVisible()
  await page.getByRole('button', { name: 'alpha.md', exact: true }).click()
  await betaButton.click()
  await expect(betaButton).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, '# Beta note')
}

function createSeededNotePaths(runId: string): SeededNotePaths {
  const folder = `storage-${runId}`

  return {
    alphaPath: `${folder}/alpha.md`,
    betaPath: `${folder}/beta.md`,
  }
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

async function createNoteInFolderFromSidebar(
  page: Page,
  folderPath: string,
  name: string,
  submitWith: 'enter' | 'blur',
): Promise<string> {
  const folderButton = page.getByRole('button', { name: folderPath, exact: true })

  await expect(folderButton).toBeVisible()
  await folderButton.hover()
  await page.getByRole('button', { name: `New note in ${folderPath}`, exact: true }).click()

  const input = page.locator('.tree-row-editor input')

  await expect(input).toHaveValue('untitled.md')
  await input.fill(name)

  if (submitWith === 'enter') {
    await input.press('Enter')
  } else {
    await page.locator('.sidebar header h2').click()
  }

  const notePath = `${folderPath}/${name}.md`
  const noteButton = page.getByRole('button', { name: `${name}.md`, exact: true })

  await expect(noteButton).toBeVisible()
  await expect(noteButton).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, '# Untitled')
  await waitForSyncIdle(page)

  return notePath
}

async function ensureFileIsOpen(page: Page, fileName: string): Promise<void> {
  const noteButton = page.getByRole('button', { name: fileName, exact: true })

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
}

async function dispatchWindowFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
  })
}

test('opens and dismisses the storage popover from the status bar button', async ({ page }) => {
  const runId = randomUUID()

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName: `picked-${runId}`,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  const storageButton = page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true })
  const storagePopover = page.locator('.statusbar-storage-popover')

  await expect(storagePopover).toBeHidden()

  await storageButton.click()

  await expect(storagePopover).toBeVisible()
  await expect(storagePopover.getByRole('button', { name: 'Attach folder' })).toBeVisible()
  await expect(storagePopover.getByRole('button', { name: 'Use OPFS' })).toBeVisible()

  await page.keyboard.press('Escape')

  await expect(storagePopover).toBeHidden()
})

test('creates and saves a note in an attached folder, then restores it after reopening', async ({ page }) => {
  const runId = randomUUID()
  const noteName = `created-${runId}`
  const pickedFolderName = `picked-${runId}`
  const savedContent = '# Stored in directory\n'

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await attachPickedFolder(page)

  const notePath = await createNoteFromSidebar(page, noteName)
  await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe('# Untitled\n')

  const syncResponsePromise = waitForNextSyncPush(page)
  await replaceEditorContent(page, savedContent)
  await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe(savedContent)
  await syncResponsePromise
  await waitForSyncIdle(page)

  const reopenedPage = await reopenAppWithHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'granted',
    requestPermission: 'granted',
  })

  await waitForSyncIdle(reopenedPage)

  await expect(reopenedPage.getByRole('button', { name: pickedFolderName, exact: true })).toBeVisible()
  await expect(reopenedPage.getByRole('button', { name: notePath, exact: true })).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(reopenedPage, '# Stored in directory')
})

test('creates only the requested note in an empty folder when submitted with Enter', async ({ page }) => {
  const runId = randomUUID()
  const folderName = `empty-folder-${runId}`
  const noteName = `created-${runId}`

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName: `picked-${runId}`,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await attachPickedFolder(page)
  await createFolderFromSidebar(page, folderName)

  const notePath = await createNoteInFolderFromSidebar(page, folderName, noteName, 'enter')

  await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe('# Untitled\n')
  await expect.poll(async () => await readPickedFolderFile(page, `${folderName}/untitled.md`)).toBe(null)
  await expect(page.getByRole('button', { name: 'untitled.md', exact: true })).toHaveCount(0)
})

test('creates only the requested note in an empty folder when submitted by blur', async ({ page }) => {
  const runId = randomUUID()
  const folderName = `empty-folder-${runId}`
  const noteName = `created-${runId}`

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName: `picked-${runId}`,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await attachPickedFolder(page)
  await createFolderFromSidebar(page, folderName)

  const notePath = await createNoteInFolderFromSidebar(page, folderName, noteName, 'blur')

  await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe('# Untitled\n')
  await expect.poll(async () => await readPickedFolderFile(page, `${folderName}/untitled.md`)).toBe(null)
  await expect(page.getByRole('button', { name: 'untitled.md', exact: true })).toHaveCount(0)
})

test('reloads the open attached-folder note after an external file edit on focus when the draft is unchanged', async ({ browser }) => {
  const runId = randomUUID()
  const userId = `storage-external-reload-${runId}`
  const pickedFolderName = `picked-${runId}`
  const notePath = `external-reload-${runId}/open.md`
  const externalContent = '# Changed outside the app\n'
  const page = await createIsolatedStoragePage(browser, userId)

  try {
    await installDateNowHarness(page)
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [{ path: notePath, content: '# Before external change\n' }])
    await ensureFileIsOpen(page, 'open.md')
    await expectEditorToContain(page, '# Before external change')

    await writePickedFolderFiles(page, [{ path: notePath, content: externalContent }])
    await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe(externalContent)

    await advanceDateNow(page, 11_000)

    const syncResponsePromise = waitForNextSyncPush(page)
    await dispatchWindowFocus(page)
    await syncResponsePromise
    await waitForSyncIdle(page)

    await expect(page.getByRole('button', { name: 'open.md', exact: true })).toHaveAttribute('aria-current', 'true')
    await expectEditorToContain(page, '# Changed outside the app')
    await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe(externalContent)
    await expect(page.getByRole('button', { name: new RegExp(`File conflict: ${RegExp.escape(notePath)}`) })).toHaveCount(0)
  } finally {
    await page.context().close()
  }
})

test('surfaces a local file conflict for the open attached-folder note after an external file edit on focus', async ({ browser }) => {
  const runId = randomUUID()
  const userId = `storage-external-conflict-${runId}`
  const pickedFolderName = `picked-${runId}`
  const notePath = `external-conflict-${runId}/open.md`
  const externalContent = '# Changed outside the app\n'
  const localDraft = '# Local draft in the app\n'
  const page = await createIsolatedStoragePage(browser, userId)

  try {
    await installDateNowHarness(page)
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [{ path: notePath, content: '# Before external conflict\n' }])
    await ensureFileIsOpen(page, 'open.md')
    await expectEditorToContain(page, '# Before external conflict')

    await writePickedFolderFiles(page, [{ path: notePath, content: externalContent }])
    await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe(externalContent)

    await advanceDateNow(page, 11_000)
    await replaceEditorContent(page, localDraft)
    await dispatchWindowFocus(page)

    await expect(page.getByRole('button', { name: new RegExp(`File conflict: ${RegExp.escape(notePath)}`) })).toBeVisible()
    await expectEditorToContain(page, '# Local draft in the app')
    await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe(externalContent)
  } finally {
    await page.context().close()
  }
})

test('reloads repeated external saves for the open attached-folder note without restoring an older snapshot', async ({ browser }) => {
  const runId = randomUUID()
  const userId = `storage-external-repeat-${runId}`
  const pickedFolderName = `picked-${runId}`
  const notePath = `external-repeat-${runId}/open.md`
  const firstExternalContent = '# Changed outside the app once\n'
  const secondExternalContent = '# Changed outside the app twice\n'
  const page = await createIsolatedStoragePage(browser, userId)

  try {
    await installDateNowHarness(page)
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [{ path: notePath, content: '# Before repeated external changes\n' }])
    await ensureFileIsOpen(page, 'open.md')
    await expectEditorToContain(page, '# Before repeated external changes')

    await writePickedFolderFiles(page, [{ path: notePath, content: firstExternalContent }])
    await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe(firstExternalContent)

    await advanceDateNow(page, 11_000)

    let syncResponsePromise = waitForNextSyncPush(page)
    await dispatchWindowFocus(page)
    await syncResponsePromise
    await waitForSyncIdle(page)

    await expectEditorToContain(page, '# Changed outside the app once')
    await expect(page.getByRole('button', { name: new RegExp(`File conflict: ${RegExp.escape(notePath)}`) })).toHaveCount(0)

    await writePickedFolderFiles(page, [{ path: notePath, content: secondExternalContent }])
    await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe(secondExternalContent)

    await advanceDateNow(page, 11_000)

    syncResponsePromise = waitForNextSyncPush(page)
    await dispatchWindowFocus(page)
    await syncResponsePromise
    await waitForSyncIdle(page)

    await expect(page.getByRole('button', { name: 'open.md', exact: true })).toHaveAttribute('aria-current', 'true')
    await expectEditorToContain(page, '# Changed outside the app twice')
    await expect.poll(async () => await readPickedFolderFile(page, notePath)).toBe(secondExternalContent)
    await expect(page.getByRole('button', { name: new RegExp(`File conflict: ${RegExp.escape(notePath)}`) })).toHaveCount(0)
  } finally {
    await page.context().close()
  }
})

test('falls back to the remaining note when the open attached-folder note is deleted externally and the draft is unchanged', async ({ browser }) => {
  const runId = randomUUID()
  const userId = `storage-external-delete-reload-${runId}`
  const pickedFolderName = `picked-${runId}`
  const remainingNotePath = `external-delete-${runId}/keep.md`
  const deletedNotePath = `external-delete-${runId}/open.md`
  const page = await createIsolatedStoragePage(browser, userId)

  try {
    await installDateNowHarness(page)
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [
      { path: remainingNotePath, content: '# Keep this note\n' },
      { path: deletedNotePath, content: '# Delete this note outside the app\n' },
    ])
    await ensureFileIsOpen(page, 'open.md')
    await expectEditorToContain(page, '# Delete this note outside the app')

    await deletePickedFolderEntry(page, deletedNotePath)
    await expect.poll(async () => await readPickedFolderFile(page, deletedNotePath)).toBe(null)

    await advanceDateNow(page, 11_000)

    const syncResponsePromise = waitForNextSyncPush(page)
    await dispatchWindowFocus(page)
    await syncResponsePromise
    await waitForSyncIdle(page)

    await expect(page.getByRole('button', { name: 'open.md', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'keep.md', exact: true })).toHaveAttribute('aria-current', 'true')
    await expectEditorToContain(page, '# Keep this note')
    await expect.poll(async () => await readPickedFolderFile(page, deletedNotePath)).toBe(null)
    await expect.poll(async () => await readPickedFolderFile(page, remainingNotePath)).toBe('# Keep this note\n')
    await expect(page.getByRole('button', { name: new RegExp(`File conflict: ${RegExp.escape(deletedNotePath)}`) })).toHaveCount(0)
  } finally {
    await page.context().close()
  }
})

test('surfaces a local file conflict when the open attached-folder note is deleted externally with local edits', async ({ browser }) => {
  const runId = randomUUID()
  const userId = `storage-external-delete-conflict-${runId}`
  const pickedFolderName = `picked-${runId}`
  const deletedNotePath = `external-delete-conflict-${runId}/open.md`
  const localDraft = '# Local draft kept in the app\n'
  const page = await createIsolatedStoragePage(browser, userId)

  try {
    await installDateNowHarness(page)
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [{ path: deletedNotePath, content: '# Delete this note with local edits\n' }])
    await ensureFileIsOpen(page, 'open.md')
    await expectEditorToContain(page, '# Delete this note with local edits')

    await deletePickedFolderEntry(page, deletedNotePath)
    await expect.poll(async () => await readPickedFolderFile(page, deletedNotePath)).toBe(null)

    await advanceDateNow(page, 11_000)
    await replaceEditorContent(page, localDraft)
    await dispatchWindowFocus(page)
    await waitForSyncIdle(page)

    await expect(page.getByRole('button', { name: new RegExp(`File conflict: ${RegExp.escape(deletedNotePath)}`) })).toBeVisible()
    await expect(page.getByRole('button', { name: 'open.md', exact: true })).toHaveAttribute('aria-current', 'true')
    await expectEditorToContain(page, '# Local draft kept in the app')
    await expect.poll(async () => await readPickedFolderFile(page, deletedNotePath)).toBe(null)
  } finally {
    await page.context().close()
  }
})

test('keeps the current OPFS workspace active when attach folder permission is denied', async ({ page }) => {
  const runId = randomUUID()
  const noteName = `opfs-note-${runId}`
  const pickedFolderName = `picked-${runId}`

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'denied',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  const notePath = await createNoteFromSidebar(page, noteName)

  await waitForSyncIdle(page)
  await expect(page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true })).toBeVisible()

  await page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true }).click()
  await page.locator('.statusbar-storage-popover').getByRole('button', { name: 'Attach folder' }).click()

  await expect(page.locator('.statusbar-message')).toHaveText('Folder access was not granted')
  await expect(page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: notePath, exact: true })).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, '# Untitled')
  await expect(page.getByRole('button', { name: pickedFolderName, exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Reconnect ${pickedFolderName}`, exact: true })).toHaveCount(0)
  await expect(page.locator('.editor-empty-panel')).toHaveCount(0)
})

test('keeps the current OPFS workspace active when attach folder is cancelled', async ({ page }) => {
  const runId = randomUUID()
  const noteName = `opfs-cancel-${runId}`
  const pickedFolderName = `picked-${runId}`

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    pickerBehavior: 'abort',
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await page.goto('/')
  await expect(page).toHaveTitle('Note')
  await waitForSyncIdle(page)

  const notePath = await createNoteFromSidebar(page, noteName)

  await waitForSyncIdle(page)
  await expect(page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true })).toBeVisible()

  await page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true }).click()
  await page.locator('.statusbar-storage-popover').getByRole('button', { name: 'Attach folder' }).click()

  await expect(page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: notePath, exact: true })).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(page, '# Untitled')
  await expect(page.locator('.statusbar-message')).toHaveText('')
  await expect(page.getByRole('button', { name: pickedFolderName, exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Reconnect ${pickedFolderName}`, exact: true })).toHaveCount(0)
  await expect(page.locator('.editor-empty-panel')).toHaveCount(0)
})

test('switches from an attached folder back to OPFS and keeps OPFS after reopening', async ({ page }) => {
  const runId = randomUUID()
  const pickedFolderName = `picked-${runId}`
  const directoryNotePath = `switch-${runId}/from-directory-${runId}.md`
  const secondDirectoryNotePath = `switch-${runId}/other-directory-${runId}.md`
  const opfsNoteName = `after-switch-${runId}`
  const opfsSavedContent = '# Saved in OPFS after switch\n'

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await attachPickedFolder(page, [
    { path: directoryNotePath, content: '# Directory note\n' },
    { path: secondDirectoryNotePath, content: '# Other directory note\n' },
  ])

  await page.getByRole('button', { name: `other-directory-${runId}.md`, exact: true }).click()
  await expectEditorToContain(page, '# Other directory note')
  await expect(page.locator('.statusbar-storage').getByRole('button', { name: pickedFolderName, exact: true })).toBeVisible()

  await page.locator('.statusbar-storage').getByRole('button', { name: pickedFolderName, exact: true }).click()
  await page.locator('.statusbar-storage-popover').getByRole('button', { name: 'Use OPFS' }).click()
  await waitForSyncIdle(page)

  await expect(page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `from-directory-${runId}.md`, exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: `other-directory-${runId}.md`, exact: true })).toHaveCount(0)
  await expect.poll(async () => await readPickedFolderFile(page, directoryNotePath)).toBe('# Directory note\n')
  await expect.poll(async () => await readPickedFolderFile(page, secondDirectoryNotePath)).toBe('# Other directory note\n')

  const opfsNotePath = await createNoteFromSidebar(page, opfsNoteName)
  const syncResponsePromise = waitForNextSyncPush(page)

  await replaceEditorContent(page, opfsSavedContent)
  await expect.poll(async () => await readOpfsFile(page, opfsNotePath)).toBe(opfsSavedContent)
  await syncResponsePromise
  await waitForSyncIdle(page)

  const reopenedPage = await reopenAppWithHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'granted',
    requestPermission: 'granted',
  })

  await waitForSyncIdle(reopenedPage)

  await expect(reopenedPage.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true })).toBeVisible()
  await expect(reopenedPage.getByRole('button', { name: `from-directory-${runId}.md`, exact: true })).toHaveCount(0)
  await expect(reopenedPage.getByRole('button', { name: `other-directory-${runId}.md`, exact: true })).toHaveCount(0)
  await expect(reopenedPage.getByRole('button', { name: opfsNotePath, exact: true })).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(reopenedPage, '# Saved in OPFS after switch')
})

test('deletes the open note from an attached folder and falls back to the remaining note', async ({ browser }) => {
  const runId = randomUUID()
  const pickedFolderName = `picked-${runId}`
  const remainingNotePath = `delete-${runId}/keep-${runId}.md`
  const deletedNotePath = `delete-${runId}/remove-${runId}.md`
  const page = await createIsolatedStoragePage(browser, `storage-delete-${runId}`)

  try {
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [
      { path: remainingNotePath, content: '# Keep me\n' },
      { path: deletedNotePath, content: '# Remove me\n' },
    ])

    const deletedNoteButton = page.getByRole('button', { name: `remove-${runId}.md`, exact: true })
    const remainingNoteButton = page.getByRole('button', { name: `keep-${runId}.md`, exact: true })

    await ensureFileIsOpen(page, `remove-${runId}.md`)
    await expectEditorToContain(page, '# Remove me')

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toBe(`Delete ${deletedNotePath}?`)
      await dialog.accept()
    })

    await deletedNoteButton.focus()
    await page.getByRole('button', { name: `Delete ${deletedNotePath}`, exact: true }).click()
    await waitForSyncIdle(page)

    await expect.poll(async () => await readPickedFolderFile(page, deletedNotePath)).toBe(null)
    await expect.poll(async () => await readPickedFolderFile(page, remainingNotePath)).toBe('# Keep me\n')
    await expect(page.getByRole('button', { name: `remove-${runId}.md`, exact: true })).toHaveCount(0)
    await expect(remainingNoteButton).toHaveAttribute('aria-current', 'true')
    await expectEditorToContain(page, '# Keep me')
  } finally {
    await page.context().close()
  }
})

test('reveals file and folder tree actions on hover', async ({ browser }) => {
  const runId = randomUUID()
  const pickedFolderName = `picked-${runId}`
  const folderPath = `hover-${runId}`
  const fileName = `show-actions-${runId}.md`
  const filePath = `${folderPath}/${fileName}`
  const page = await createIsolatedStoragePage(browser, `storage-hover-${runId}`)

  try {
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [{ path: filePath, content: '# Hover me\n' }])

    const folderRow = page.locator('.tree-row', {
      has: page.getByRole('button', { name: folderPath, exact: true }),
    })
    const fileRow = page.locator('.tree-row', {
      has: page.getByRole('button', { name: fileName, exact: true }),
    })
    const folderActions = folderRow.locator('.tree-actions')
    const fileActions = fileRow.locator('.tree-actions')

    await expect(folderActions).toBeHidden()
    await expect(fileActions).toBeHidden()

    await folderRow.hover()
    await expect(folderActions).toBeVisible()

    await fileRow.hover()
    await expect(fileActions).toBeVisible()
  } finally {
    await page.context().close()
  }
})

test('enters file rename mode on a second click of the focused open file', async ({ browser }) => {
  const runId = randomUUID()
  const pickedFolderName = `picked-${runId}`
  const notePath = `second-click-${runId}/rename-me-${runId}.md`
  const fileName = `rename-me-${runId}.md`
  const page = await createIsolatedStoragePage(browser, `storage-second-click-${runId}`)

  try {
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [{ path: notePath, content: '# Rename me\n' }])

    await expectEditorToContain(page, '# Rename me')
    await enterRenameModeFromFocusedOpenFile(page, fileName)

    await expect(page.locator('.tree-row-editor input')).toHaveValue(fileName)
  } finally {
    await page.context().close()
  }
})

test('selects only the basename when file rename mode opens', async ({ browser }) => {
  const runId = randomUUID()
  const pickedFolderName = `picked-${runId}`
  const fileName = `rename-selection-${runId}.md`
  const notePath = `selection-${runId}/${fileName}`
  const basenameEnd = fileName.lastIndexOf('.')
  const page = await createIsolatedStoragePage(browser, `storage-rename-selection-${runId}`)

  try {
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [{ path: notePath, content: '# Rename me\n' }])

    await expectEditorToContain(page, '# Rename me')
    await enterRenameModeFromFocusedOpenFile(page, fileName)

    const renameInput = page.locator('.tree-row-editor input')

    await expect(renameInput).toHaveValue(fileName)
    await expect(renameInput).toBeFocused()
    await expect.poll(async () => await renameInput.evaluate((element) => {
      const input = element as HTMLInputElement

      return {
        end: input.selectionEnd,
        start: input.selectionStart,
      }
    })).toEqual({ start: 0, end: basenameEnd })
  } finally {
    await page.context().close()
  }
})

test('keeps the rename input focused across repeated clicks once file rename mode is open', async ({ browser }) => {
  const runId = randomUUID()
  const pickedFolderName = `picked-${runId}`
  const fileName = `rename-focus-${runId}.md`
  const notePath = `rename-focus-${runId}/${fileName}`
  const page = await createIsolatedStoragePage(browser, `storage-rename-focus-${runId}`)

  try {
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [{ path: notePath, content: '# Rename me\n' }])

    await expectEditorToContain(page, '# Rename me')
    await enterRenameModeFromFocusedOpenFile(page, fileName)

    const renameInput = page.locator('.tree-row-editor input')

    await expect(renameInput).toBeFocused()
    await renameInput.click()
    await expect(renameInput).toBeFocused()
    await expect(renameInput).toHaveValue(fileName)
  } finally {
    await page.context().close()
  }
})

test('renames the open note in an attached folder and restores the renamed path after reopening', async ({ browser }) => {
  const runId = randomUUID()
  const pickedFolderName = `picked-${runId}`
  const originalNotePath = `rename-${runId}/before-${runId}.md`
  const siblingNotePath = `rename-${runId}/sibling-${runId}.md`
  const renamedNoteName = `after-${runId}.md`
  const renamedNotePath = `rename-${runId}/${renamedNoteName}`
  const page = await createIsolatedStoragePage(browser, `storage-rename-${runId}`)

  try {
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [
      { path: originalNotePath, content: '# Rename me\n' },
      { path: siblingNotePath, content: '# Leave me alone\n' },
    ])

    const originalNoteButton = page.getByRole('button', { name: `before-${runId}.md`, exact: true })
    const siblingNoteButton = page.getByRole('button', { name: `sibling-${runId}.md`, exact: true })

    await ensureFileIsOpen(page, `sibling-${runId}.md`)
    await expectEditorToContain(page, '# Leave me alone')

    await ensureFileIsOpen(page, `before-${runId}.md`)
    await expectEditorToContain(page, '# Rename me')

    await originalNoteButton.focus()
    await page.getByRole('button', { name: `Rename ${originalNotePath}`, exact: true }).click()

    const renameInput = page.locator('.tree-row-editor input')
    await expect(renameInput).toHaveValue(`before-${runId}.md`)
    await renameInput.fill(renamedNoteName)
    await renameInput.press('Enter')
    await waitForSyncIdle(page)

    await expect.poll(async () => await readPickedFolderFile(page, originalNotePath)).toBe(null)
    await expect.poll(async () => await readPickedFolderFile(page, renamedNotePath)).toBe('# Rename me\n')
    await expect(page.getByRole('button', { name: `before-${runId}.md`, exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: renamedNoteName, exact: true })).toHaveAttribute('aria-current', 'true')
    await expect(siblingNoteButton).toHaveCount(1)
    await expectEditorToContain(page, '# Rename me')

    const reopenedPage = await reopenAppWithHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'granted',
      requestPermission: 'granted',
    })

    await waitForSyncIdle(reopenedPage)

    await expect(reopenedPage.locator('.statusbar-storage').getByRole('button', { name: pickedFolderName, exact: true })).toBeVisible()
    await expect(reopenedPage.getByRole('button', { name: `before-${runId}.md`, exact: true })).toHaveCount(0)
    await expect(reopenedPage.getByRole('button', { name: renamedNoteName, exact: true })).toHaveAttribute('aria-current', 'true')
    await expectEditorToContain(reopenedPage, '# Rename me')
  } finally {
    await page.context().close()
  }
})

test('falls back to the remaining note on startup when the saved path is missing', async ({ browser }) => {
  const runId = randomUUID()
  const pickedFolderName = `picked-${runId}`
  const remainingNotePath = `missing-${runId}/keep-${runId}.md`
  const missingNotePath = `missing-${runId}/gone-${runId}.md`
  const page = await createIsolatedStoragePage(browser, `storage-missing-${runId}`)

  try {
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await attachPickedFolder(page, [
      { path: remainingNotePath, content: '# Keep on startup\n' },
      { path: missingNotePath, content: '# Open me first\n' },
    ])

    await ensureFileIsOpen(page, `keep-${runId}.md`)
    await expectEditorToContain(page, '# Keep on startup')
    await ensureFileIsOpen(page, `gone-${runId}.md`)
    await expectEditorToContain(page, '# Open me first')
    await expect.poll(async () => (await readStoredAppSettings(page))?.lastOpenedPath).toBe(missingNotePath)

    await ensureFileIsOpen(page, `keep-${runId}.md`)
    await expectEditorToContain(page, '# Keep on startup')
    await updateStoredAppSettings(page, {
      backend: 'directory',
      lastOpenedPath: missingNotePath,
    })
    await expect.poll(async () => (await readStoredAppSettings(page))?.lastOpenedPath).toBe(missingNotePath)

    await deletePickedFolderEntry(page, missingNotePath)
    await expect.poll(async () => await readPickedFolderFile(page, remainingNotePath)).toBe('# Keep on startup\n')

    const reopenedPage = await reopenAppWithHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      queryPermission: 'granted',
      requestPermission: 'granted',
    })

    await waitForSyncIdle(reopenedPage)

    await expect(reopenedPage.locator('.statusbar-storage').getByRole('button', { name: pickedFolderName, exact: true })).toBeVisible()
    await expect(reopenedPage.getByRole('button', { name: `gone-${runId}.md`, exact: true })).toHaveCount(0)
    await expect(reopenedPage.getByRole('button', { name: `keep-${runId}.md`, exact: true })).toHaveAttribute('aria-current', 'true')
    await expectEditorToContain(reopenedPage, '# Keep on startup')
    await expect.poll(async () => (await readStoredAppSettings(reopenedPage))?.lastOpenedPath).toBe(remainingNotePath)
  } finally {
    await page.context().close()
  }
})

test('shows the unsupported-browser attach error and keeps the OPFS workspace active', async ({ browser }) => {
  const runId = randomUUID()
  const pickedFolderName = `picked-${runId}`
  const page = await createIsolatedStoragePage(browser, `storage-unsupported-${runId}`)

  try {
    await installStorageHarness(page, {
      appOpfsRootName: `app-opfs-${runId}`,
      pickedFolderName,
      pickerBehavior: 'unsupported',
      queryPermission: 'prompt',
      requestPermission: 'granted',
    })

    await page.goto('/')
    await expect(page).toHaveTitle('Note')
    await waitForSyncIdle(page)

    const notePath = await createNoteFromSidebar(page, `unsupported-${runId}`)

    await waitForSyncIdle(page)
    await expect(page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true })).toBeVisible()

    await page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true }).click()
    await page.locator('.statusbar-storage-popover').getByRole('button', { name: 'Attach folder' }).click()

    await expect(page.locator('.statusbar-message')).toHaveText('This browser does not support the File System Access API.')
    await expect(page.locator('.statusbar-storage').getByRole('button', { name: 'OPFS', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: notePath, exact: true })).toHaveAttribute('aria-current', 'true')
    await expectEditorToContain(page, '# Untitled')
    await expect(page.getByRole('button', { name: pickedFolderName, exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: `Reconnect ${pickedFolderName}`, exact: true })).toHaveCount(0)
    await expect(page.locator('.editor-empty-panel')).toHaveCount(0)
  } finally {
    await page.context().close()
  }
})

test('attaches a folder and restores the last opened note after reopening the app', async ({ page }) => {
  const runId = randomUUID()
  const paths = createSeededNotePaths(runId)
  const pickedFolderName = `picked-${runId}`

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await attachPickedFolderAndOpenLastNote(page, paths)

  const reopenedPage = await reopenAppWithHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'granted',
    requestPermission: 'granted',
  })

  await waitForSyncIdle(reopenedPage)

  await expect(reopenedPage.getByRole('button', { name: pickedFolderName, exact: true })).toBeVisible()
  await expect(reopenedPage.getByRole('button', { name: 'beta.md', exact: true })).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(reopenedPage, '# Beta note')
})

test('shows reconnect state on startup when the saved folder permission is pending', async ({ page }) => {
  const runId = randomUUID()
  const paths = createSeededNotePaths(runId)
  const pickedFolderName = `picked-${runId}`

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await attachPickedFolderAndOpenLastNote(page, paths)

  const reopenedPage = await reopenAppWithHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })

  const reconnectLabel = `Reconnect ${pickedFolderName}`

  await expect(reopenedPage.getByRole('heading', { name: 'Folder access is needed to reopen your notes.' })).toBeVisible()
  await expect(reopenedPage.locator('.editor-empty-panel').getByRole('button', { name: reconnectLabel })).toBeVisible()
  await expect(reopenedPage.locator('.statusbar-storage').getByRole('button', { name: reconnectLabel, exact: true })).toBeVisible()
  await expect(reopenedPage.getByRole('button', { name: /^Sync/ })).toBeDisabled()
  await expect(reopenedPage.getByRole('button', { name: 'beta.md', exact: true })).toHaveCount(0)
})

test('reconnects the saved folder and restores the last opened note without another click', async ({ page }) => {
  const runId = randomUUID()
  const paths = createSeededNotePaths(runId)
  const pickedFolderName = `picked-${runId}`

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await attachPickedFolderAndOpenLastNote(page, paths)

  const reopenedPage = await reopenAppWithHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })

  await reopenedPage.locator('.editor-empty-panel').getByRole('button', { name: `Reconnect ${pickedFolderName}` }).click()
  await waitForSyncIdle(reopenedPage)

  await expect(reopenedPage.getByRole('button', { name: pickedFolderName, exact: true })).toBeVisible()
  await expect(reopenedPage.getByRole('button', { name: 'beta.md', exact: true })).toHaveAttribute('aria-current', 'true')
  await expectEditorToContain(reopenedPage, '# Beta note')
  await expect(reopenedPage.locator('.editor-empty-panel')).toHaveCount(0)
})

test('keeps reconnect available and shows an error when folder access is denied', async ({ page }) => {
  const runId = randomUUID()
  const paths = createSeededNotePaths(runId)
  const pickedFolderName = `picked-${runId}`

  await installStorageHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'granted',
  })
  await installTestUserHeader(page, `storage-page-${runId}`)

  await attachPickedFolderAndOpenLastNote(page, paths)

  const reopenedPage = await reopenAppWithHarness(page, {
    appOpfsRootName: `app-opfs-${runId}`,
    pickedFolderName,
    queryPermission: 'prompt',
    requestPermission: 'denied',
  })

  const reconnectLabel = `Reconnect ${pickedFolderName}`

  await reopenedPage.locator('.editor-empty-panel').getByRole('button', { name: reconnectLabel }).click()

  await expect(reopenedPage.locator('.statusbar-message')).toHaveText('Folder access was not granted')
  await expect(reopenedPage.locator('.editor-empty-panel').getByRole('button', { name: reconnectLabel })).toBeVisible()
  await expect(reopenedPage.locator('.statusbar-storage').getByRole('button', { name: reconnectLabel, exact: true })).toBeVisible()
  await expect(reopenedPage.getByRole('button', { name: /^Sync/ })).toBeDisabled()
  await expect(reopenedPage.getByRole('button', { name: 'beta.md', exact: true })).toHaveCount(0)
})
