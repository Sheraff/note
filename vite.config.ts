import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  environments: {
    client: {
      consumer: 'client',
      build: {
        outDir: 'dist/client',
        emptyOutDir: true,
      },
    },
    server: {
      consumer: 'server',
      build: {
        ssr: 'server/index.ts',
        outDir: 'dist/server',
        emptyOutDir: true,
        target: 'node24',
        rolldownOptions: {
          output: {
            entryFileNames: 'server.js',
          },
        },
      },
    },
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
