import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Cordis and storage fixtures register process-wide services; parallel
    // files can overlap teardown and make the real-composition tests flaky.
    maxWorkers: 1,
    minWorkers: 1,
  },
})
