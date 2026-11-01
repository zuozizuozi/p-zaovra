const options = ["--max-concurrency", "2", "--timeout", "30000", "--only-failures"]
const args = process.argv.slice(2)
// Keep explicit, focused Bun invocations intact. The default full suite isolates
// native footer rendering so a crash cannot discard the other files' summary.
const groups = args.length
  ? [{ name: "selected", args }]
  : [
      { name: "package", args: ["--path-ignore-patterns=**/footer.view.test.tsx"] },
      { name: "footer", args: ["./test/cli/run/footer.view.test.tsx"] },
    ]

let failed = false
for (const group of groups) {
  console.log(`test:${group.name} starting`)
  const child = Bun.spawn([process.execPath, "test", ...options, ...group.args], {
    cwd: import.meta.dir + "/..",
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exit = await child.exited
  console.log(`test:${group.name} exit=${exit}${child.signalCode ? ` signal=${child.signalCode}` : ""}`)
  if (exit !== 0) failed = true
}
process.exit(failed ? 1 : 0)
