import config from "./playwright.config"
export default {
  ...config,
  projects: [{ name: "chromium", use: { ...config.projects?.[0]?.use, channel: "chrome" } }],
}
