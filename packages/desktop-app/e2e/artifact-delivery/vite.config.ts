import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"
import appPlugin from "../../../app-ui/vite.js"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [appPlugin],
  build: { target: "esnext", sourcemap: true },
})
