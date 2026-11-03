import config from "../vite.config"
export default {
  ...config,
  build: { ...config.build, rollupOptions: { input: { main: "index.html", desktop: "e2e/fixtures/desktop550.html" } } },
}
