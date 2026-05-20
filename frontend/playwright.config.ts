import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    // Start the dhee backend (assumes pnpm dev is configured)
    {
      command: 'cd .. && pnpm dev',
      port: 3000,
      timeout: 30000,
      reuseExistingServer: true,
    },
    // Start the Vite dev server
    {
      command: 'npm run dev',
      port: 5173,
      timeout: 15000,
      reuseExistingServer: true,
    },
  ],
})
