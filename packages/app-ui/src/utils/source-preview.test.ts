import { expect, test } from "bun:test"
import { sourcePreviewNeedsBuild } from "./source-preview"

test("warns for bundled source entries without treating built or static pages as source", () => {
  const source = '<script type="module" src="/src/main.ts"></script>'
  const manifest = '{"scripts":{"dev":"vite --host","build":"vite build"}}'
  expect(sourcePreviewNeedsBuild("index.html", source, manifest)).toBe(true)
  expect(sourcePreviewNeedsBuild("dist/index.html", source, manifest)).toBe(false)
  expect(sourcePreviewNeedsBuild("dist\\index.html", source, manifest)).toBe(false)
  expect(sourcePreviewNeedsBuild("index.html", "<h1>static</h1>", manifest)).toBe(false)
  expect(sourcePreviewNeedsBuild("index.html", source, "{}")).toBe(false)
})
