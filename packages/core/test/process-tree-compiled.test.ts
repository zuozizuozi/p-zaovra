import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ProcessTree } from "@zaovra-ai/core/process-tree"

test.skipIf(!ProcessTree.supported())(
  "owns a real command from a minified standalone Bun executable",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zaovra-native-compiled-"))
    try {
      const executable = path.join(directory, "owner" + (process.platform === "win32" ? ".exe" : ""))
      const base = process.env.ZAOVRA_TEST_COMPILE_BASE
      if (base) {
        const hash = async (file: string) =>
          new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
        expect(await hash(base)).toBe(await hash(process.execPath))
      }
      const compiler = Bun.spawn(
        [
          process.execPath,
          "build",
          "--compile",
          "--minify",
          ...(base ? ["--compile-executable-path=" + base] : []),
          path.join(import.meta.dir, "fixture/process-tree-compiled.ts"),
          "--outfile",
          executable,
        ],
        { cwd: directory, env: process.env, stdout: "pipe", stderr: "pipe" },
      )
      const [compiled, , diagnostics] = await Promise.all([
        compiler.exited,
        new Response(compiler.stdout).text(),
        new Response(compiler.stderr).text(),
      ])
      expect(compiled, diagnostics).toBe(0)
      const bytes = await Bun.file(executable).arrayBuffer()
      console.info(
        JSON.stringify({
          phase: "compiled-owner-fixture623",
          bytes: bytes.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        }),
      )
      const child = Bun.spawn([executable], { cwd: directory, env: process.env, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.output).toBe("compiled-owner623")
      expect(result.stderr).toBe("")
      expect(result.exit).toEqual([0, null])
      expect(result.pid).toBeGreaterThan(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  60000,
)
