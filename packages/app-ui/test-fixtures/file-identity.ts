import { mock } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { createRoot } from "solid-js"
import { artifactPath } from "../src/utils/artifact-path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-identity-"))
const pairs = [
  ["report.txt#L10", "report.txt"],
  ["report%2Etxt", "report.txt"],
  ["dir%2Ffile.txt", "dir/file.txt"],
  ["a%20b.txt", "a b.txt"],
  ["中文 空格.txt", "中文.txt"],
]
let dispose = () => {}
try {
  for (const [correct, wrong] of pairs) {
    await fs.mkdir(path.dirname(path.join(root, wrong!)), { recursive: true })
    await Bun.write(path.join(root, wrong!), "WRONG")
    await Bun.write(path.join(root, correct!), `RIGHT:${correct}`)
  }
  mock.module("@solidjs/router", () => ({ useParams: () => ({ id: "test" }) }))
  mock.module("@zaovra-ai/ui/context", () => ({
    createSimpleContext: (options: { init: () => unknown }) => ({ use: options.init }),
  }))
  mock.module("../src/context/sdk", () => ({
    useSDK: () => () => ({
      directory: root,
      client: {
        file: {
          list: async () => ({ data: (await fs.readdir(root)).map((name) => ({ name, path: name, type: "file" })) }),
          read: async (input: { path: string }) => ({
            data: { type: "text", content: await Bun.file(path.join(root, input.path)).text() },
          }),
        },
        find: { files: async () => ({ data: pairs.map(([correct]) => correct) }) },
      },
      event: { listen: () => () => {} },
    }),
  }))
  mock.module("../src/context/sync", () => ({ useSync: () => ({}) }))
  mock.module("../src/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: "local" }) }))
  mock.module("../src/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("../src/context/layout", () => ({ useLayout: () => ({ tabs: () => ({ all: () => [] }) }) }))
  mock.module("../src/utils/toast", () => ({ showToast: () => {} }))
  mock.module("../src/utils/persist", () => ({
    Persist: { serverScoped: () => ({}) },
    persisted: (_key: unknown, store: unknown[]) => [...store, undefined, () => true],
  }))
  const { useFile } = await import("../src/context/file")
  const file = createRoot((cleanup) => {
    dispose = cleanup
    return useFile()
  })
  await file.tree.list("")
  const found = await file.searchFiles("")
  for (const [correct] of pairs) {
    assert.ok(file.tree.children("").some((node) => node.path === correct))
    assert.ok(found.includes(correct!))
    const detail = artifactPath(correct!, root)!
    assert.equal(detail.path, correct)
    const tab = file.tab(detail.path)
    assert.equal(file.pathFromTab(tab), correct)
    await file.load(detail.path)
    assert.equal(file.get(correct!)?.content?.content, `RIGHT:${correct}`)
    assert.equal(file.get(tab), file.get(correct!))
    await file.load(tab, { force: true })
    assert.equal(file.get(tab)?.content?.content, `RIGHT:${correct}`)
    const url = pathToFileURL(path.join(root, correct!)).href
    assert.equal(file.normalize(url), correct)
    await file.load(url, { force: true })
    assert.equal(file.get(url), file.get(correct!))
  }
  for (const rejected of ["../outside.txt", "https://evil.test/file", "javascript:alert(1)", "file:///%2e%2e/outside"])
    assert.equal(artifactPath(rejected, root), undefined)
  console.log("FileContext identities passed")
} finally {
  dispose()
  await fs.rm(root, { recursive: true, force: true })
}
