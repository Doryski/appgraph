/// <reference types="node" />
import { defineConfig, devices } from "@playwright/test"

const isCi = Boolean(process.env.CI)

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  reporter: [["list"], ["html", { open: "never" }]],
  retries: isCi ? 1 : 0,
  outputDir: "test-results",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1512, height: 905 } },
    },
  ],
})
