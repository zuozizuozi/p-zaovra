import path from "node:path"
import { realpath, readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"

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

export function previewURL(target: string) {
  const url = new URL(target)
  if (url.username || url.password) throw new Error("预览地址不能包含账号密码")
  if (url.protocol === "https:") return url.href
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.href
  throw new Error("请使用 HTTPS 网站或本机开发服务地址")
}

export async function serveArtifact(target: string, directory: string) {
  const root = await realpath(directory)
  const file = await realpath(path.resolve(root, target))
  const relative = path.relative(root, file)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("请选择当前项目中的成果文件")
  if (!types[path.extname(file).toLowerCase()]) throw new Error("此格式请使用文件查看器打开")
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end()
        return
      }
      const address = server.address()
      if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`) {
        response.writeHead(403).end()
        return
      }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname)
      if (pathname.split("/").some((part) => part.startsWith("."))) {
        response.writeHead(403).end()
        return
      }
      const resolved = await realpath(path.resolve(root, `.${pathname}`))
      const relative = path.relative(root, resolved)
      const mime = types[path.extname(resolved).toLowerCase()]
      if (relative.startsWith("..") || path.isAbsolute(relative) || !mime) {
        response.writeHead(403).end()
        return
      }
      const info = await stat(resolved)
      if (!info.isFile() || info.size > 100 * 1024 * 1024) {
        response.writeHead(413).end()
        return
      }
      response.writeHead(200, {
        "Content-Type": mime,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      })
      response.end(request.method === "HEAD" ? undefined : await readFile(resolved))
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
    url: `http://127.0.0.1:${address.port}/${relative.split(path.sep).map(encodeURIComponent).join("/")}`,
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
