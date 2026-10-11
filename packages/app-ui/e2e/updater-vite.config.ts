import { mergeConfig } from "vite"
import config from "../vite.config"

export default mergeConfig(config, {
  plugins: [
    {
      name: "test-updater-platform",
      enforce: "pre",
      transform(source: string, id: string) {
        if (!id.replaceAll("\\", "/").endsWith("/src/entry.tsx")) return
        return `import { updater } from "../e2e/utils/updater-platform";\n${source.replace("const platform: Platform = {", "const platform: Platform = { updater,")}`
      },
    },
  ],
})
