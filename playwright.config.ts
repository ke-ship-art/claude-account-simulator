import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5174', browserName: 'chromium', channel: 'chrome', headless: true },
  webServer: { command: 'npm run dev -- --port 5174 --strictPort', url: 'http://127.0.0.1:5174/api/provider', reuseExistingServer: false, timeout: 30_000, env: { CLAUDE_SIM_CONFIG_PATH: join(tmpdir(), 'claude-account-simulator-playwright-5174.dat') } },
})
