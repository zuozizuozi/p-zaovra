import { expect, test } from "bun:test"
import { join } from "node:path"
async function inspect(gate: string, extra?: [string, string]) {
  const entries: [string, string][] = [
    ["zaovra-desktop-win-x64.exe", "synthetic installer, never execute"],
    ["zaovra-desktop-win-x64.exe.blockmap", "map"],
    ["beta.yml", "version: 0.1.1-beta.3"],
    ["notes.md", "synthetic"],
    ["ci-gate.json", gate],
  ]
  if (extra) entries.push(extra)
  const zip = Bun.spawn(
    [
      process.env.PYTHON ?? "python3",
      "-c",
      "import io,sys,json,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); [z.writestr(k,v) for k,v in json.load(sys.stdin)]; z.close(); sys.stdout.buffer.write(b.getvalue())",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  zip.stdin.write(JSON.stringify(entries))
  zip.stdin.end()
  const [body, error, code] = await Promise.all([
    new Response(zip.stdout).arrayBuffer(),
    new Response(zip.stderr).text(),
    zip.exited,
  ])
  expect(code, error).toBe(0)
  const reader = Bun.spawn([process.env.PYTHON ?? "python3", join(import.meta.dir, "beta-build-report.py")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  reader.stdin.write(body)
  reader.stdin.end()
  const [out, err, exit] = await Promise.all([
    new Response(reader.stdout).text(),
    new Response(reader.stderr).text(),
    reader.exited,
  ])
  return { out, err, exit }
}
test("193 build ZIP reader reads only structured gate, never installer code", async () => {
  const r = await inspect('{"commit":"synthetic"}')
  expect(r.exit, r.err).toBe(0)
  expect(JSON.parse(r.out)).toEqual({ commit: "synthetic" })
})
test("193 build ZIP rejects duplicate metadata keys and entries", async () => {
  expect((await inspect('{"commit":"a","commit":"b"}')).exit).not.toBe(0)
  expect((await inspect("{}", ["ci-gate.json", "{}"])).exit).not.toBe(0)
})
test("193 build ZIP rejects traversal and metadata over the limit", async () => {
  expect((await inspect("{}", ["../outside", "x"])).exit).not.toBe(0)
  expect((await inspect(JSON.stringify({ body: "x".repeat(65536) }))).exit).not.toBe(0)
})
