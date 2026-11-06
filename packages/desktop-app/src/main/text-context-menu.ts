import { app, BrowserWindow, Menu } from "electron"
import { editableTextMenu } from "./text-context-menu-policy"

export function installTextContextMenus() {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("context-menu", async (_event, params) => {
      if (!params.isEditable) return
      const locale: unknown = await contents.executeJavaScript("document.documentElement.lang").catch(() => "en")
      if (contents.isDestroyed()) return
      Menu.buildFromTemplate(editableTextMenu(params, typeof locale === "string" ? locale : "en")).popup({
        window: BrowserWindow.fromWebContents(contents) ?? undefined,
      })
    })
  })
}
