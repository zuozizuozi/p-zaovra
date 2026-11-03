import { randomUUID } from "node:crypto"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { MAX_ATTACHMENT_BYTES } from "./attachment-picker"

export async function storeAttachment(input: { directory: string; name: string; bytes: ArrayBuffer }) {
  if (!path.isAbsolute(input.directory)) throw new Error("请先选择本机工作区，再添加此文件")
  if (!(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw new Error("文件过大，请选择 100 MB 以内的附件")
  const root = await realpath(input.directory)
  const folder = path.join(root, ".zaovra", "attachments")
  // Refuse redirected attachment folders so a drop cannot write outside the selected workspace.
  for (const directory of [path.join(root, ".zaovra"), folder]) {
    await mkdir(directory, { recursive: true })
    const relative = path.relative(root, await realpath(directory))
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("附件目录指向工作区之外，请检查 .zaovra 目录")
  }
  const name =
    input.name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(-160) || "attachment"
  const target = path.join(folder, `${randomUUID().slice(0, 8)}-${name}`)
  await writeFile(target, new Uint8Array(input.bytes), { flag: "wx" })
  return { path: target, name: input.name, size: input.bytes.byteLength }
}
