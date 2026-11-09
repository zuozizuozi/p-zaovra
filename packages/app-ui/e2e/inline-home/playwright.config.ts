import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "inline-home.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  outputDir: process.env.QA_INLINE_ROOT + "/" + (process.env.QA_INLINE_RUN ?? "test-results"),
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:4563",
    viewport: { width: 1280, height: 860 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
