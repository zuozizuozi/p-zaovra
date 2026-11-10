import { createHash, randomUUID } from "node:crypto"
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { artifactFileAction } from "./artifact-server"

type Input = { target: string; directory: string }

export async function inspectArtifactFile(input: Input) {
  let info: { bytes: number; created: number; modified: number } | undefined
  await artifactFileAction({ ...input, action: "reveal" }, async (file) => {
    const metadata = await stat(file)
    info = { bytes: metadata.size, created: metadata.birthtimeMs, modified: metadata.mtimeMs }
  })
  if (!info) throw new Error("文件不可用")
  return info
}

export async function saveArtifactFile(input: Input, choose: (name: string) => Promise<string | undefined>) {
  // The renderer supplies only the project source. The destination comes from the native dialog.
  const before = await artifactSource(input)
  const destination = await choose(path.basename(before.path))
  if (!destination) return
  const source = await artifactSource(input)
  if (source.path !== before.path || source.identity !== before.identity || !source.bytes.equals(before.bytes))
    throw new Error("文件已变化，请重新另存")
  if (!path.isAbsolute(destination) || /[\r\n\0]/.test(destination)) throw new Error("另存路径不可用")
  const parent = await realpath(path.dirname(destination))
  const target = path.join(parent, path.basename(destination))
  const original = await destinationIdentity(target)
  if (original?.identity === source.identity) throw new Error("请选择与原文件不同的另存位置")
  const temporary = path.join(parent, `.zaovra-save-${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    try {
      await handle.writeFile(source.bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (JSON.stringify(await destinationIdentity(target)) !== JSON.stringify(original))
      throw new Error("另存目标已变化，请重新选择")
    await rename(temporary, target)
    const written = await readFile(target)
    if (!written.equals(source.bytes)) throw new Error("另存文件校验失败")
    return { path: target, bytes: written.length, sha256: createHash("sha256").update(written).digest("hex") }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

async function artifactSource(input: Input) {
  let source: { path: string; identity: string; bytes: Buffer } | undefined
  await artifactFileAction({ ...input, action: "reveal" }, async (file) => {
    const handle = await open(file, "r")
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error("文件不可用或超过 100 MB")
      const bytes = await handle.readFile()
      const current = await handle.stat()
      if (info.size !== current.size || info.mtimeMs !== current.mtimeMs || bytes.length !== current.size)
        throw new Error("文件已变化，请重试")
      source = { path: file, identity: `${info.dev}:${info.ino}`, bytes }
    } finally {
      await handle.close()
    }
  })
  if (!source) throw new Error("文件不可用")
  return source
}

async function destinationIdentity(target: string) {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  if (!info) return
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("请选择普通文件作为另存目标")
  return { identity: `${info.dev}:${info.ino}`, bytes: info.size, modified: info.mtimeMs }
}
