import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  clearScreen: false,
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'solid',
          environment: 'jsdom',
          include: ['test/**/*.solid.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['test/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            // pnpm gives the provider package a separate Vitest type identity, but the runtime config is valid.
            provider: playwright() as never,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
