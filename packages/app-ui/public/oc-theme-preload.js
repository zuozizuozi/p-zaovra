;(function () {
  var key = "zaovra-theme-id"
  var themeId = localStorage.getItem(key) || "oc-2"

  if (themeId !== "oc-2") {
    themeId = "oc-2"
    localStorage.setItem(key, themeId)
  }
  // App offers one theme in light/dark; never flash cached legacy colors.
  localStorage.removeItem("zaovra-theme-css-light")
  localStorage.removeItem("zaovra-theme-css-dark")

  var scheme = localStorage.getItem("zaovra-color-scheme") || "light"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.colorScheme = mode
  document.documentElement.style.backgroundColor = isDark ? "#080808" : "#fafafa"

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", isDark ? "#080808" : "#fafafa")
})()
