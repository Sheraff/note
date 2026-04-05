import { defineConfig } from '@playwright/test'

const port = 4173
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.browser.test.ts',
  use: {
    baseURL,
  },
  webServer: {
    command: `node dist/server/server.js --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
  },
})
