const { contextBridge, ipcRenderer } = require("electron")
contextBridge.exposeInMainWorld("fixtureApi", { submit: (value) => ipcRenderer.invoke("fixture:feedback", value) })
