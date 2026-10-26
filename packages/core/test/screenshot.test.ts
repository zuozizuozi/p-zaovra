import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Screenshot } from "../src/screenshot"

test("managed screenshot reads enforce session, storage, size, type and retention", async () => {
  const root = process.env.ZAOVRA_SCREENSHOT_TEST_ROOT ?? os.tmpdir()
  await fs.mkdir(root, { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, "screenshot-"))
  const id = `tool_${Buffer.from("ses_image").toString("hex")}_sample.png`
  const file = path.join(directory, id)
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  try {
    await fs.writeFile(file, png)
    expect(Screenshot.reference(file)).toBe(id)
    expect(Screenshot.reference(file)).not.toContain(directory)
    expect(() => Screenshot.reference(path.join(directory, "secret.png"))).toThrow("Invalid")
    expect(await Screenshot.read(directory, "ses_image", id)).toEqual(png)
    await expect(Screenshot.read(directory, "ses_other", id)).rejects.toThrow("owned")
    await expect(Screenshot.read(directory, "ses_image", `../${id}`)).rejects.toThrow("owned")
    await expect(Screenshot.read(directory, "ses_image", file)).rejects.toThrow("owned")
    await expect(Screenshot.read(path.join(directory, "other-server"), "ses_image", id)).rejects.toThrow()
    await fs.writeFile(file, Buffer.concat([png, Buffer.alloc(Screenshot.MAX_BYTES - png.length)]))
    expect((await Screenshot.read(directory, "ses_image", id)).length).toBe(Screenshot.MAX_BYTES)
    await fs.appendFile(file, "x")
    await expect(Screenshot.read(directory, "ses_image", id)).rejects.toThrow("4 MiB")
    await fs.writeFile(file, "not a PNG")
    await expect(Screenshot.read(directory, "ses_image", id)).rejects.toThrow("Invalid PNG")
    await fs.writeFile(file, png)
    const expired = new Date(Date.now() - Screenshot.RETENTION_MS - 1000)
    await fs.utimes(file, expired, expired)
    await expect(Screenshot.read(directory, "ses_image", id)).rejects.toThrow("expired")
    await fs.unlink(file)
    await expect(Screenshot.read(directory, "ses_image", id)).rejects.toThrow()
    await fs.mkdir(file)
    await expect(Screenshot.read(directory, "ses_image", id)).rejects.toThrow("Invalid screenshot source")
    await fs.rmdir(file)
    const target = path.join(directory, "outside.png")
    await fs.writeFile(target, png)
    await fs.symlink(target, file, "file")
    await expect(Screenshot.read(directory, "ses_image", id)).rejects.toThrow("Invalid screenshot source")
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(root)) throw new Error("Invalid cleanup directory")
    await fs.rm(directory, { recursive: true, force: true })
  }
})
