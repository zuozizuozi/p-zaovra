import assert from "node:assert/strict"
import { AppProcess } from "../../src/process"

assert.equal(process.platform, "linux")
const bash = Bun.which("bash")
assert.ok(bash, "fixture requires an installed bash")
assert.equal(AppProcess.resolveShell(), bash)
assert.equal(AppProcess.resolveShell("/bin/sh"), "/bin/sh")
assert.equal(AppProcess.resolveShell("/bin/bash"), "/bin/bash")
process.env.PATH = "/no-commands"
assert.equal(AppProcess.resolveShell(), "/bin/sh")
for (const shell of ["/bin/bash", "/bin/sh"]) {
  const result = Bun.spawnSync([AppProcess.resolveShell(shell), "-c", "printf 'shell-ready'"], {
    env: { PATH: "/usr/bin:/bin" },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.toString(), "shell-ready")
}
console.log("PASS: bash preference, sh fallback, explicit paths and both real shells")
