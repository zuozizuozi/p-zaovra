import { mergeConfig } from "vite"
import config from "../../vite.config"

export default mergeConfig(config, {
  cacheDir: process.env.QA_INLINE_ROOT + "/vite-cache",
  build: { outDir: process.env.QA_INLINE_ROOT + "/renderer-build", sourcemap: false },
  server: { host: "127.0.0.1", port: 4563, strictPort: true },
})
