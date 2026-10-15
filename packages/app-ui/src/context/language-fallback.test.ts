import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

for (const locale of ["en", "zh"])
  test(`real language fallback and unknown permission notification: ${locale}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        "./test-fixtures/language-notification.ts",
        locale,
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output, error }).toEqual({ code: 0, output: "Language and notification passed\n", error: "" })
  }, 15000)
