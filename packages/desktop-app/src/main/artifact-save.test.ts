import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { inspectArtifactFile, saveArtifactFile } from "./artifact-save"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zaovra-artifact-save-"))
  roots.push(root)
  await mkdir(path.join(root, "project"))
  await mkdir(path.join(root, "saved"))
  const bytes = Buffer.from([0, 255, 13, 10, 37, 80, 68, 70, 0, 128])
  await writeFile(path.join(root, "project", "成果 report.pdf"), bytes)
  return { root, bytes, input: { target: "成果 report.pdf", directory: path.join(root, "project") } }
}

test("Save As writes actual binary bytes, verifies the destination and preserves the source", async () => {
  const { root, input, bytes } = await fixture()
  const destination = path.join(root, "saved", "副本.pdf")
  const saved = await saveArtifactFile(input, async (name) => {
    expect(name).toBe(input.target)
    return destination
  })
  expect(saved).toEqual({
    path: destination,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })
  expect(await readFile(destination)).toEqual(bytes)
  expect(await readFile(path.join(input.directory, input.target))).toEqual(bytes)
  expect(await readdir(path.dirname(destination))).toEqual(["副本.pdf"])
  expect(await inspectArtifactFile(input)).toMatchObject({
    bytes: bytes.length,
    created: expect.any(Number),
    modified: expect.any(Number),
  })
})

test("cancel is write-free; a changed source during the dialog is rejected before writing", async () => {
  const { root, input } = await fixture()
  const destination = path.join(root, "saved", "copy.pdf")
  expect(await saveArtifactFile(input, async () => undefined)).toBeUndefined()
  expect(await readdir(path.dirname(destination))).toEqual([])
  await expect(
    saveArtifactFile(input, async () => {
      await writeFile(path.join(input.directory, input.target), "changed")
      return destination
    }),
  ).rejects.toThrow("文件已变化")
  expect(await readdir(path.dirname(destination))).toEqual([])
})

test("missing, outside and linked sources never open the picker; empty files remain valid", async () => {
  const { root, input } = await fixture()
  await writeFile(path.join(root, "outside.pdf"), "outside")
  await symlink(path.join(root, "outside.pdf"), path.join(input.directory, "linked.pdf"))
  let pickers = 0
  for (const target of ["missing.pdf", "../outside.pdf", "linked.pdf", ".", "https://example.com/a.pdf"]) {
    await expect(
      saveArtifactFile({ ...input, target }, async () => {
        pickers++
        return undefined
      }),
    ).rejects.toThrow()
    await expect(inspectArtifactFile({ ...input, target })).rejects.toThrow()
  }
  expect(pickers).toBe(0)
  await writeFile(path.join(input.directory, "empty.txt"), "")
  expect(await inspectArtifactFile({ ...input, target: "empty.txt" })).toMatchObject({ bytes: 0 })
})

test("confirmed overwrite replaces bytes, while same source and symlink destinations stay intact", async () => {
  const { root, input, bytes } = await fixture()
  const destination = path.join(root, "saved", "copy.pdf")
  await writeFile(destination, "old destination")
  expect((await saveArtifactFile(input, async () => destination))?.bytes).toBe(bytes.length)
  expect(await readFile(destination)).toEqual(bytes)
  await expect(saveArtifactFile(input, async () => path.join(input.directory, input.target))).rejects.toThrow("不同")
  await symlink(destination, path.join(root, "saved", "linked.pdf"))
  await expect(saveArtifactFile(input, async () => path.join(root, "saved", "linked.pdf"))).rejects.toThrow("普通文件")
  expect(await readFile(destination)).toEqual(bytes)
})
