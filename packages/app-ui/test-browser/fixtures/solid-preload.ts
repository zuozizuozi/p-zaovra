import { plugin } from "bun"
import solid from "vite-plugin-solid"

// Bun's default TSX transform is not Solid's DOM compiler.
const compiler = solid({ hot: false, dev: false })
plugin({
  name: "solid-dom-fixture",
  setup(build) {
    // Vite exposes worker asset imports as URLs; this DOM fixture does not run Markdown workers.
    build.onLoad({ filter: /\?worker&url$/ }, (args) => ({
      contents: `export default ${JSON.stringify(args.path)}`,
      loader: "js",
    }))
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const source =
        process.env.QA_REVERT_BENCH_DOCK_SOURCE && args.path.replaceAll("\\", "/").endsWith("/session-revert-dock.tsx")
          ? process.env.QA_REVERT_BENCH_DOCK_SOURCE
          : args.path
      const result = await compiler.transform.call({} as never, await Bun.file(source).text(), args.path)
      if (!result || typeof result === "string") throw new Error(`Solid transform failed: ${args.path}`)
      return { contents: result.code, loader: "ts" }
    })
  },
})
