import { BrowserWindow, WebContentsView, session } from "electron"
import type { WebContents } from "electron"
import type { ArtifactPreviewAPI, ArtifactState } from "@zaovra-ai/app/artifact-preview"
import { previewURL, serveArtifact, readArtifactPDF } from "./artifact-server"

export function createArtifactPreview(owner: WebContents) {
  let current: { id: string; view: WebContentsView; state: ArtifactState; closeServer?: () => void } | undefined
  let requested: string | undefined
  const browsing = session.fromPartition(`artifact-${owner.id}`)
  browsing.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browsing.setPermissionCheckHandler(() => false)
  const download = (event: Electron.Event) => {
    event.preventDefault()
    if (current) current.state.error = "请在外部浏览器中下载文件"
  }
  browsing.on("will-download", download)
  const close = () => {
    const task = current
    current = undefined
    if (!task) return
    BrowserWindow.fromWebContents(owner)?.contentView.removeChildView(task.view)
    if (!task.view.webContents.isDestroyed()) task.view.webContents.close()
    task.closeServer?.()
  }
  owner.once("destroyed", () => {
    requested = undefined
    browsing.removeListener("will-download", download)
    close()
  })
  const api: ArtifactPreviewAPI = {
    readPDF: (input) => readArtifactPDF(input.target, input.directory),
    async open(input) {
      requested = input.id
      close()
      const local = /^https?:\/\//i.test(input.target) ? undefined : await serveArtifact(input.target, input.directory)
      if (requested !== input.id || owner.isDestroyed()) {
        local?.close()
        return
      }
      const url = local?.url ?? previewURL(input.target)
      const window = BrowserWindow.fromWebContents(owner)
      if (!window) {
        local?.close()
        throw new Error("预览窗口不可用")
      }
      const view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          partition: `artifact-${owner.id}`,
          webSecurity: true,
        },
      })
      const contents = view.webContents
      const state: ArtifactState = { url, title: input.target, loading: true, zoom: 1 }
      current = { id: input.id, view, state, closeServer: local?.close }
      contents.setWindowOpenHandler(() => {
        state.error = "该链接需要新窗口，请在外部浏览器中打开"
        return { action: "deny" }
      })
      contents.on("will-navigate", (event, next) => {
        try {
          previewURL(next)
        } catch {
          event.preventDefault()
          state.error = "已阻止不支持的页面跳转"
        }
      })
      contents.on("will-redirect", (event, next) => {
        try {
          previewURL(next)
        } catch {
          event.preventDefault()
        }
      })
      contents.on("page-title-updated", (_event, title) => {
        state.title = title
      })
      contents.on("did-start-loading", () => {
        state.loading = true
        state.error = undefined
      })
      contents.on("did-stop-loading", () => {
        state.loading = false
        if (!contents.isDestroyed()) state.url = contents.getURL()
      })
      contents.on("did-fail-load", (_event, code, _description, _url, main) => {
        if (main && code !== -3) {
          state.loading = false
          state.error = "页面加载失败，请确认文件存在或网站服务已启动"
        }
      })
      contents.on("render-process-gone", () => {
        state.error = "预览页面已停止，请重新打开"
        state.loading = false
      })
      view.setVisible(false)
      window.contentView.addChildView(view)
      void contents.loadURL(url).catch(() => {
        state.loading = false
        state.error = "页面加载失败，请确认网站服务已启动"
      })
    },
    async bounds(input) {
      if (current?.id !== input.id) return
      const scale = owner.getZoomFactor()
      const bounds = Object.fromEntries(
        Object.entries(input.bounds).map(([key, value]) => [key, Math.max(0, Math.round(value * scale))]),
      ) as typeof input.bounds
      if (Object.values(bounds).some((value) => !Number.isFinite(value))) return
      current.view.setBounds(bounds)
      current.view.setVisible(input.visible && bounds.width > 0 && bounds.height > 0)
    },
    async action(input) {
      if (input.action === "close" && requested === input.id) requested = undefined
      if (current?.id !== input.id) return
      if (input.action === "close") {
        close()
        return
      }
      if (input.action === "reload") {
        current.view.webContents.reload()
        return
      }
      current.state.zoom =
        input.action === "reset"
          ? 1
          : Math.min(2, Math.max(0.5, current.state.zoom + (input.action === "zoom-in" ? 0.1 : -0.1)))
      current.view.webContents.setZoomFactor(current.state.zoom)
    },
    async state(id) {
      return current?.id === id ? { ...current.state } : undefined
    },
  }
  return api
}
