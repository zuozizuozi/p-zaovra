import { defineConfig } from "electron-vite"
import path from "node:path"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
const server = path.resolve(root, "../zaovra/dist/node")
const output = process.env.ZAOVRA_LIFECYCLE_BUILD
if (!output) throw new Error("ZAOVRA_LIFECYCLE_BUILD must select an isolated fixture output directory")

export default defineConfig({
  main: {
    root,
    define: { "import.meta.env.ZAOVRA_CHANNEL": JSON.stringify("dev") },
    build: {
      outDir: output,
      externalizeDeps: false,
      rollupOptions: {
        input: {
          owner: path.join(root, "test/fixture/service-owner.ts"),
          sidecar: path.join(root, "src/main/sidecar.ts"),
        },
        external: ["electron", "@lydell/node-pty-win32-x64", "playwright-core"],
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
    },
    plugins: [
      {
        name: "lifecycle-real-sidecar",
        resolveId(id) {
          if (id === "virtual:zaovra-server") return path.join(server, "node.js")
          if (id === "zaovra-web-ui.gen.ts") return path.join(server, id)
        },
        async writeBundle() {
          for (const file of await fs.readdir(server)) {
            if (!file.endsWith(".wasm")) continue
            await fs.mkdir(path.join(output, "chunks"), { recursive: true })
            await fs.copyFile(path.join(server, file), path.join(output, "chunks", file))
          }
        },
      },
    ],
  },
})
