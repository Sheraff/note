import { expect, test } from '@playwright/test'

test('loads the real app frontend from /', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle('Note')
  await expect(page.getByText('Notes')).toBeVisible()
  await expect(page.getByRole('button', { name: 'OPFS' })).toBeVisible()
})
