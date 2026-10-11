import path from "node:path"
import { readdir, realpath } from "node:fs/promises"
import { createRequire } from "node:module"

const root = path.resolve(import.meta.dir, "..")
const packages = new Map<
  string,
  {
    name: string
    version: string
    license?: string
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
>()
const owners = new Map<string, string | undefined>()

async function owner(file: string): Promise<string | undefined> {
  const dir = path.dirname(file.split("?")[0])
  if (owners.has(dir)) return owners.get(dir)
  const manifest = Bun.file(path.join(dir, "package.json"))
  if (await manifest.exists()) {
    const data = await manifest.json()
    if (data.name && data.version) {
      packages.set(dir, data)
      owners.set(dir, dir)
      return dir
    }
  }
  const parent = path.dirname(dir)
  const result = parent === dir ? undefined : await owner(dir)
  owners.set(dir, result)
  return result
}

for (const input of ["out/main", "out/preload", "out/renderer", "../zaovra/dist/node"]) {
  const files: string[] = await Bun.file(path.join(root, input, "notices-inputs.json")).json()
  for (const file of files) await owner(file)
}

const visited = new Set<string>()
async function runtime(dir: string) {
  if (visited.has(dir)) return
  visited.add(dir)
  const data = await Bun.file(path.join(dir, "package.json")).json()
  packages.set(dir, data)
  const require = createRequire(path.join(dir, "package.json"))
  for (const dependency of Object.keys({ ...data.dependencies, ...data.optionalDependencies })) {
    const target = await (async () => {
      // Some packages do not export their manifest or a default entry point.
      const found = await realpath(path.join(dir, "node_modules", dependency)).catch(() => undefined)
      if (found) return found
      const entry = (() => {
        try {
          return require.resolve(`${dependency}/package.json`)
        } catch {}
        try {
          return require.resolve(dependency)
        } catch {
          return undefined
        }
      })()
      return entry ? owner(entry) : undefined
    })()
    if (target) await runtime(target)
    else if (data.dependencies?.[dependency]) throw new Error(`Missing packaged dependency: ${dependency}`)
  }
}
await runtime(root)

const sections: string[] = [
  "Zaovra third-party notices\nGenerated from bundled module inventories and installed desktop runtime dependencies.\n",
]
for (const [dir, data] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const files = (await readdir(dir)).filter((file) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(file))
  const texts = await Promise.all(files.map(async (file) => `${file}\n${await Bun.file(path.join(dir, file)).text()}`))
  const fallback =
    data.name === "poe-oauth"
      ? "poe-code-LICENSE.txt"
      : data.name.startsWith("@zaovra-ai/") || data.name === "zaovra"
        ? "Zaovra-MIT.txt"
        : `spdx/${data.license?.toLowerCase() === "apache-2.0" ? "Apache-2.0" : data.license}.txt`
  const license = texts.length
    ? texts.join("\n\n")
    : `The installed package omits its license file. Supplement: ${fallback}\n${await Bun.file(path.join(root, "resources/licenses", fallback)).text()}`
  sections.push(`${data.name} ${data.version}\nLicense: ${data.license ?? "See upstream license"}\n${license}`)
}
for (const file of (await readdir(path.join(root, "resources/licenses"), { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)) {
  sections.push(`${file}\n${await Bun.file(path.join(root, "resources/licenses", file)).text()}`)
}
await Bun.write(path.join(root, "resources/THIRD_PARTY_NOTICES.txt"), sections.join("\n\n" + "=".repeat(72) + "\n\n"))
console.log(`Third-party notices: ${packages.size} installed/bundled package roots`)
