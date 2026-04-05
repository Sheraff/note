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
    ],
  },
})
