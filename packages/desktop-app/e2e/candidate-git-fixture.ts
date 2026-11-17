import { readFileSync } from "node:fs"
import path from "node:path"

const binding = path.resolve(process.argv[2])
if (!binding.startsWith(path.resolve("F:/Zaovra-研发记录/逐次记录") + path.sep))
  throw new Error("isolated-binding-required")
const input = JSON.parse(readFileSync(binding, "utf8"))
if (!path.resolve(input.output).startsWith(path.dirname(binding) + path.sep))
  throw new Error("isolated-output-required")
const child = Bun.spawn(["node", "e2e/candidate-git.mjs", binding], {
  cwd: path.resolve(import.meta.dir, ".."),
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
})
const exit = await child.exited
const result = JSON.parse(readFileSync(path.join(input.output, "result.json"), "utf8"))
if (exit !== 0 || !result.pass) throw new Error("git-fixture-failed")
