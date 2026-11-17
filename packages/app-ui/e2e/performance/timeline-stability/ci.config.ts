import path from "node:path"
import { defineConfig } from "@playwright/test"
import config from "./playwright.config"

const evidence = process.env.ZAOVRA_E2E_REPORT_DIR
if (!evidence || !path.isAbsolute(evidence))
  throw new Error("ZAOVRA_E2E_REPORT_DIR must be an absolute evidence directory")
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)

// The original thirteen failed desktop regressions, reasoning lifecycle and explicit scroll resume.
// Keep their existing assertions and production-build fixtures; these are not the DOM unit suite.
export default defineConfig({
  ...config,
  testDir: ".",
  testIgnore: [],
  testMatch: ["desktop-refresh.spec.ts", "lifecycle.spec.ts", "task-mascot.spec.ts", "scroll-interaction.spec.ts"],
  grep: /(?:error card keeps \w+ details behind disclosure|completed work folds without hiding the delivered response|synthetic continuations share one disclosure and preserve final text|empty checks remain absent and error recovery remains available beside its card|error-only replies and synthetic continuation share one resident heading|streams empty, short, and long parallel shells to staggered completion|replaces thinking with streamed reasoning and text without a blank visible turn|jump to latest overrides a just-finished wheel gesture without waiting for another event)$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: path.join(evidence, "results"),
  reporter: [["json", { outputFile: path.join(evidence, "report.json") }], ["line"]],
  use: { ...config.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    ...config.webServer,
    cwd: path.resolve(import.meta.dirname, "../../.."),
    command: `bun run build && bun run serve -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { VITE_ZAOVRA_SERVER_HOST: "127.0.0.1", VITE_ZAOVRA_SERVER_PORT: String(port) },
  },
})
