import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { storeAttachment } from "./attachment-store"

test("refuses an attachment directory redirected outside the workspace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "attachment-boundary-"))
  const outside = await mkdtemp(path.join(tmpdir(), "attachment-outside-"))
  try {
    await symlink(outside, path.join(directory, ".zaovra"), "junction")
    await expect(storeAttachment({ directory, name: "sample.wav", bytes: new ArrayBuffer(4) })).rejects.toThrow(
      "工作区之外",
    )
    expect(await readdir(outside)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
