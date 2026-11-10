import path from "node:path"
import { realpath, readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { createHash } from "node:crypto"

const types: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".md": "text/plain",
}

export async function artifactFileAction(
  input: { target: string; directory: string; action: "open" | "reveal" },
  run: (file: string, action: "open" | "reveal") => Promise<void>,
) {
  if (
    !input ||
    typeof input.target !== "string" ||
    typeof input.directory !== "string" ||
    !["open", "reveal"].includes(input.action) ||
    /[\r\n\0]/.test(input.target) ||
    /^[a-z][\w+.-]*:/i.test(input.target)
  )
    throw new Error("请选择当前项目中的文件")
  const root = await realpath(input.directory)
  const resolve = async () => {
    const file = await realpath(path.resolve(root, input.target))
    const relative = path.relative(root, file)
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
      throw new Error("请选择当前项目中的文件")
    const info = await stat(file)
    if (!info.isFile()) throw new Error("请选择文件")
    return { file, identity: [info.dev, info.ino, info.birthtimeMs].join(":") }
  }
  const before = await resolve()
  const current = await resolve()
  if (
    input.action === "open" &&
    /\.(?:exe|com|bat|cmd|ps1|psm1|msi|lnk|url|reg|vbs|vbe|js|jse|scr|pif|hta|scf)$/i.test(current.file)
  )
    throw new Error("此文件请在文件夹中查看，不在预览中执行")
  if (
    (await realpath(input.directory)) !== root ||
    before.file !== current.file ||
    before.identity !== current.identity
  )
    throw new Error("文件已变化，请重新选择")
  await run(current.file, input.action)
}

export function previewURL(target: string) {
  const url = new URL(target)
  if (url.username || url.password) throw new Error("预览地址不能包含账号密码")
  if (url.protocol === "https:") return url.href
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.href
  throw new Error("请使用 HTTPS 网站或本机开发服务地址")
}

export async function artifactSource(target: string, directory: string) {
  const root = await realpath(directory)
  const file = await realpath(path.resolve(root, target))
  const relative = path.relative(root, file)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("请选择当前项目中的成果文件")
  if (!types[path.extname(file).toLowerCase()]) throw new Error("此格式请使用文件查看器打开")
  // Reuse the app's standard `oc` scheme, in a project-only session. Neither
  // the origin nor storage identity depends on a port, view, or owner window.
  const host = `artifact-${createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex")}`
  const origin = `oc://${host}`
  const accepts = (target: string) => {
    const url = new URL(target)
    return url.protocol === "oc:" && url.host === host && !url.username && !url.password
  }
  return {
    url: `${origin}/${relative.split(path.sep).map(encodeURIComponent).join("/")}`,
    partition: `persist:${host}`,
    accepts,
    async respond(request: Pick<Request, "url" | "method"> & { initiatorOrigin?: string }) {
      try {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 })
        if (!accepts(request.url) || (request.initiatorOrigin && request.initiatorOrigin !== origin))
          return new Response(null, { status: 403 })
        const pathname = decodeURIComponent(new URL(request.url).pathname)
        if (pathname.split("/").some((part) => part.startsWith("."))) return new Response(null, { status: 403 })
        const resolved = await realpath(path.resolve(root, `.${pathname}`))
        const relative = path.relative(root, resolved)
        const mime = types[path.extname(resolved).toLowerCase()]
        if (relative.startsWith("..") || path.isAbsolute(relative) || !mime) return new Response(null, { status: 403 })
        const info = await stat(resolved)
        if (!info.isFile() || info.size > 100 * 1024 * 1024) return new Response(null, { status: 413 })
        return new Response(request.method === "HEAD" ? null : new Uint8Array(await readFile(resolved)), {
          headers: {
            "Content-Type": mime,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        })
      } catch {
        return new Response("File unavailable", { status: 404 })
      }
    },
  }
}

export async function serveArtifact(target: string, directory: string) {
  const source = await artifactSource(target, directory)
  const server = createServer(async (request, response) => {
    const address = server.address()
    if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`) {
      response.writeHead(403).end()
      return
    }
    try {
      const result = await source.respond({
        url: new URL(request.url ?? "/", source.url).href,
        method: request.method ?? "GET",
      })
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(Buffer.from(await result.arrayBuffer()))
    } catch {
      response.writeHead(404).end("File unavailable")
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("无法创建本地预览")
  return {
    url: `http://127.0.0.1:${address.port}${new URL(source.url).pathname}`,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

export async function readArtifactPDF(target: string, directory: string) {
  const root = await realpath(directory)
  const file = await realpath(path.resolve(root, target))
  const relative = path.relative(root, file)
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(file).toLowerCase() !== ".pdf")
    throw new Error("请选择当前项目中的 PDF 文件")
  const info = await stat(file)
  if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error("PDF 不能超过 50 MB")
  const data = await readFile(file)
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}
