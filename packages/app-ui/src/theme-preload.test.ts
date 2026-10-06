import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("migrates legacy oc-1 to oc-2 before mount", () => {
    localStorage.setItem("zaovra-theme-id", "oc-1")
    localStorage.setItem("zaovra-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("zaovra-theme-css-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("zaovra-theme-id")).toBe("oc-2")
    expect(localStorage.getItem("zaovra-theme-css-light")).toBeNull()
    expect(localStorage.getItem("zaovra-theme-css-dark")).toBeNull()
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })

  test.each(["light", "dark", "system"])("falls back from legacy themes while preserving %s preference", (scheme) => {
    localStorage.setItem("zaovra-theme-id", "nightowl")
    localStorage.setItem("zaovra-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("zaovra-theme-css-dark", "--background-base:#000;")
    localStorage.setItem("zaovra-color-scheme", scheme)

    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(localStorage.getItem("zaovra-theme-id")).toBe("oc-2")
    expect(localStorage.getItem("zaovra-color-scheme")).toBe(scheme)
    expect(document.documentElement.dataset.colorScheme).toBe(scheme === "dark" ? "dark" : "light")
    expect(localStorage.getItem("zaovra-theme-css-light")).toBeNull()
    expect(localStorage.getItem("zaovra-theme-css-dark")).toBeNull()
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })
})
