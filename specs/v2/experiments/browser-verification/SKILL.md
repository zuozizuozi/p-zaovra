---
name: browser-verification
description: Build and verify browser apps, HTML demos, and games using an existing browser driver, reproducible assertions, and a small test loop. Use for browser-facing implementation or interaction bugs.
---

# Browser implementation and verification

Use the project's browser tests or available browser tools first. This skill is guidance for the existing shell and file tools; it does not supply a browser, install packages, or grant permissions.

## Get a working test loop early

- For a new app, implement a small runnable version and open it before expanding styling or optional features. Keep the user's required behaviors in scope. Test the riskiest state transitions while the code and history are still small.
- Inspect the package manifest and relevant project instructions once. Reuse an existing Playwright/Puppeteer setup. If none exists and development dependencies are allowed, install a project-local browser driver with the project's package manager. An offline deliverable does not imply zero development dependencies.
- Launch a browser before writing a large test suite. If compatible Chrome or Edge is already installed, Playwright can use `chromium.launch({ channel: 'chrome', headless: true })` or `channel: 'msedge'` without a Chromium download. Preserve a project's pinned browser setup when reproducibility requires it. If no usable browser exists, install the required Playwright browser within permissions.
- Do not build a custom WebSocket/CDP client for an ordinary browser task when an established driver is available. After a failed installation or launch, inspect that error and choose a supported alternative; repeated environment scans are not progress.

A small `.mjs` launch probe, run from a project containing `playwright`:

```js
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(pathToFileURL(path.resolve('index.html')).href)
  console.log({ title: await page.title(), errors })
  if (errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
```

Use the actual development URL for apps needing a server. A launch probe alone is not functional acceptance.

## Assert behavior, not the test's own setup

- Write a compact list of expected outcomes from the request. Exercise controls through `page.keyboard`, locators, and pointer input. Assert the resulting UI or application state. Clicking without checking the effect is not an interaction test.
- Use auto-retrying assertions or `page.waitForFunction` for observable state changes. For animation/canvas output, wait for rendering before sampling pixels. Isolate cases with a fresh page or explicit reset, so one failed test does not cause unrelated failures.
- Cover boundaries of the implemented state machine: initial/empty state, normal progress, last item or final stage, failure, and restart. For keyboard toggles, repeated `keyboard.down` calls generate real repeat events; pair them with `keyboard.up`.
- State seeding can reach rare cases, but the production transition must produce the outcome being asserted. Setting `won = true` then asserting victory tests nothing. Keep normal-input tests too; disclose seeded tests. Test-only mutation hooks should be opt-in and absent during normal use.
- Collect `pageerror` and actual console errors separately from warnings. Save relevant screenshots for layout inspection. Do not claim visual inspection if the current tools/model cannot view them.

## Record and finish

- Keep one reproducible command and explicit coverage files. Fix the specific failed assertion or implementation, then rerun affected checks. Do not change an expected result solely to make a failing product pass, or rerun unchanged passing suites without a reason.
- Use the shell tool's `verification` for one category. For a standalone HTML suite covering syntax, startup, and interaction, `verification_report: true` accepts one JSON object with distinct actual category results in `checks`. The host combines stdout and stderr: keep extra diagnostics in a file, not either stream, for this mode. Derive statuses from executed assertions, include all covered HTML/JS/CSS/test files in `verification_targets`, and exit nonzero on failure. Missing/skipped tests are not passes.
- Preserve the same command, working directory, and target list for reruns so the host can supersede the earlier record. If a genuine scope change requires a different check, explain any remaining old failure instead of hiding it.
- Summarize what actually passed, the deliverable entry point, and uncovered behavior. Keep the final change proportionate to the request; verification should not become a larger application than the deliverable.

References: [Playwright browser channels](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge), [assertions](https://playwright.dev/docs/test-assertions), [keyboard input](https://playwright.dev/docs/api/class-keyboard).
