import { expect, test } from 'vitest'

async function waitForAppText(frame: HTMLIFrameElement, text: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const bodyText = frame.contentDocument?.body.textContent ?? ''

    if (bodyText.includes(text)) {
      return
    }

    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }

  throw new Error(`Timed out waiting for app text: ${text}`)
}

test('loads the real app frontend from /', async () => {
  document.body.innerHTML = ''

  const frame = document.createElement('iframe')

  await new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => {
      resolve()
    }, { once: true })
    frame.addEventListener('error', () => {
      reject(new Error('Expected the app iframe to load'))
    }, { once: true })
    frame.src = '/'
    document.body.append(frame)
  })

  await waitForAppText(frame, 'OPFS', 5_000)

  expect(frame.contentDocument?.title).toBe('Note')
  expect(frame.contentDocument?.body.textContent).toContain('Notes')
  expect(frame.contentDocument?.body.textContent).toContain('OPFS')
})
