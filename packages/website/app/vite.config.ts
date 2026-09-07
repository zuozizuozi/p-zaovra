import { defineConfig, PluginOption } from "vite"
import { solidStart } from "@solidjs/start/config"
import { nitro } from "nitro/vite"
import { fileURLToPath } from "node:url"

const isVercel = process.env.VERCEL === "1"

export default defineConfig({
  plugins: [
    solidStart({
      middleware: "./src/middleware.ts",
    }) as PluginOption,
    ...(isVercel ? [vercelManifest()] : []),
    nitro({
      compatibilityDate: "2024-09-19",
      preset: isVercel ? "vercel" : "cloudflare-module",
      cloudflare: isVercel ? undefined : { nodeCompat: true },
      vercel: isVercel
        ? {
            functions: {
              runtime: "nodejs22.x",
            },
          }
        : undefined,
    }),
  ],
  resolve: isVercel
    ? {
        alias: {
          "@zaovra-ai/console-resource": fileURLToPath(new URL("../resource/resource.vercel.ts", import.meta.url)),
        },
      }
    : undefined,
  server: {
    allowedHosts: true,
    port: 3001,
  },
  build: {
    rollupOptions: isVercel ? undefined : { external: ["cloudflare:workers"] },
    minify: false,
  },
})

function vercelManifest(): PluginOption {
  const clientManifest = "\0zaovra:vercel-client-manifest"
  const solidStartConfig = new URL(import.meta.resolve("@solidjs/start/config"))

  return {
    name: "zaovra:vercel-solid-start-manifest",
    enforce: "pre",
    resolveId(id) {
      if (id === "solid-start:get-manifest") {
        return fileURLToPath(new URL("../server/manifest/ssr-manifest.js", solidStartConfig))
      }
      if (id === "solid-start:client-vite-manifest") return clientManifest
    },
    load(id) {
      if (id !== clientManifest) return
      const bundle = (
        globalThis as typeof globalThis & {
          START_CLIENT_BUNDLE?: Record<string, { source: string }>
        }
      ).START_CLIENT_BUNDLE?.[".vite/manifest.json"]
      if (!bundle) throw new Error("SolidStart client manifest was not generated before the Vercel server build")
      return `export const clientViteManifest = ${bundle.source}`
    },
  }
}
