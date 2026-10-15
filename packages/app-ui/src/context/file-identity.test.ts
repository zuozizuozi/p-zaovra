import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("FileContext keeps literal file identity through list, detail, load, get and tab", async () => {
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", "--preload", "./happydom.ts", "./test-fixtures/file-identity.ts"],
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
  expect({ code, output, error }).toEqual({ code: 0, output: "FileContext identities passed\n", error: "" })
}, 15000)
