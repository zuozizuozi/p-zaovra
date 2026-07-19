import path from "node:path"
import { $ } from "bun"

const links = (await $`git ls-files -s`.text())
  .split("\n")
  .filter((line) => line.startsWith("120000 "))
  .map((line) => line.split("\t")[1])
  .filter((value): value is string => value !== undefined)

const invalid = (
  await Promise.all(
    links.map(async (link) => {
      const target = (await $`git show ${`:${link}`}`.text()).trim()
      if (!target || target.length >= 260 || target.includes("\n") || target.includes("\0")) {
        return `${link}: invalid symlink target`
      }

      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(link), target.replaceAll("\\", "/")))
      if (path.posix.isAbsolute(resolved) || resolved === ".." || resolved.startsWith("../")) {
        return `${link}: target escapes the repository (${target})`
      }

      const exact = await $`git ls-files --error-unmatch -- ${resolved}`.quiet().nothrow()
      if (exact.exitCode === 0) return undefined

      const nested = (await $`git ls-files -- ${`${resolved}/`}`.text()).trim()
      if (nested) return undefined
      return `${link}: target does not exist (${target})`
    }),
  )
).filter((value): value is string => value !== undefined)

if (invalid.length) {
  console.error(["Invalid Git symlinks:", ...invalid.map((item) => `- ${item}`)].join("\n"))
  process.exit(1)
}

console.log(`Validated ${links.length} Git symlinks`)
