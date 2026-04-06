import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'

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

async function waitForSyncIdle(page: Page): Promise<void> {
  const syncButton = page.getByRole('button', { name: /^Sync/ })

  await expect(syncButton).toBeVisible()
  await expect.poll(async () => await syncButton.getAttribute('aria-busy')).not.toBe('true')
}

async function getPlainEditorInput(page: Page): Promise<Locator> {
  const editor = page.locator('.monaco-editor').last()
  const namedInput = editor.getByRole('textbox', { name: 'Editor content' })

  return (await namedInput.count()) > 0 ? namedInput.first() : editor.getByRole('textbox').last()
}

test('focuses the editor after creating a note with Enter from the sidebar', async ({ page }) => {
  const runId = randomUUID()
  const noteName = `focus-after-create-${runId}`
  const insertedText = 'Typed after pressing Enter'

  await installTestUserHeader(page, `notes-sidebar-${runId}`)
  await page.goto('/')
  await waitForSyncIdle(page)

  await page.getByRole('button', { name: 'New note', exact: true }).click()

  const createInput = page.locator('.tree-row-editor input')

  await expect(createInput).toBeFocused()
  await createInput.fill(noteName)
  await createInput.press('Enter')

  await expect(page.getByRole('button', { name: `${noteName}.md`, exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(createInput).toHaveCount(0)

  const editorInput = await getPlainEditorInput(page)

  await expect(editorInput).toBeFocused()
  await page.keyboard.insertText(insertedText)
  await expect(page.locator('.monaco-editor .view-lines').last()).toContainText(insertedText)
})
