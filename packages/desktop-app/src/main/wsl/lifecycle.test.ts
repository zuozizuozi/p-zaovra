import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { expect, test } from "bun:test"
import { createWslStop, wslSidecarScript } from "./lifecycle"

const distro = process.env.ZAOVRA_WSL_TEST_DISTRO
const integration = process.platform === "win32" && distro ? test : test.skip

integration(
  "WSL cleanup preserves processes owned by another sidecar",
  async () => {
    const fixtures = await Promise.all(
      [0, 1].map(async () => {
        const marker = `zaovra-test-${randomUUID()}`
        const child = spawn("wsl", ["-d", distro!, "--", "bash", "-se"], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
        const stop = createWslStop(child)
        const ready = new Promise<number>((resolve, reject) => {
          child.once("error", reject)
          child.stdout.once("data", (data) => resolve(Number(String(data).trim())))
        })
        child.stdin.write(wslSidecarScript(`echo "$BASHPID"\nexec -a ${marker} sleep 90`))
        return { pid: await ready, marker, stop }
      }),
    )
    try {
      await fixtures[0]!.stop()
      const other = fixtures[1]!
      expect(Number.isInteger(other.pid) && other.pid > 1).toBe(true)
      const check = Bun.spawn(
        [
          "wsl",
          "-d",
          distro!,
          "--",
          "bash",
          "-c",
          `tr '\\0' ' ' </proc/${other.pid}/cmdline | grep -Fq '${other.marker}'`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      expect(await check.exited).toBe(0)
    } finally {
      await Promise.all(fixtures.map((fixture) => fixture.stop()))
    }
  },
  40_000,
)

for (const mode of ["stop", "launcher-crash", "ignore-term", "server-exit", "detached-tool"]) {
  integration(
    `WSL lifecycle cleans up after ${mode}`,
    async () => {
      const marker = `zaovra-test-${randomUUID()}`
      const child = spawn("wsl", ["-d", distro!, "--", "bash", "-se"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
      const stop = createWslStop(child)
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
      const pid = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WSL fixture startup timeout")), 20_000)
        child.once("error", reject)
        child.stdout.once("data", (data) => {
          clearTimeout(timeout)
          resolve(Number(String(data).trim()))
        })
      })
      child.stdin.write(
        wslSidecarScript(
          [
            mode === "ignore-term" ? "trap '' TERM" : ":",
            mode === "detached-tool"
              ? `setsid bash -c 'exec -a ${marker} sleep 90' >/dev/null 2>&1 &\necho "$!"\nwait`
              : `echo "$BASHPID"\n${mode === "server-exit" ? "exit 7" : `exec -a ${marker} sleep 90`}`,
          ].join("\n"),
        ),
      )
      const serverPID = await pid
      expect(Number.isInteger(serverPID) && serverPID > 1).toBe(true)
      try {
        if (mode === "launcher-crash") child.kill()
        if (mode === "stop" || mode === "ignore-term" || mode === "detached-tool") {
          const pending = stop()
          expect(stop()).toBe(pending)
          await pending
        }
        const code = await exited
        if (mode === "server-exit") expect(code).toBe(7)
        await Bun.sleep(500)
        const check = Bun.spawn(
          [
            "wsl",
            "-d",
            distro!,
            "--",
            "bash",
            "-c",
            `if [ -r /proc/${serverPID}/cmdline ] && tr '\\0' ' ' </proc/${serverPID}/cmdline | grep -Fq '${marker}'; then echo orphaned; kill -KILL ${serverPID}; else echo exited; fi`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        )
        expect((await new Response(check.stdout).text()).trim()).toBe("exited")
        expect(await check.exited).toBe(0)
      } finally {
        await stop()
      }
    },
    40_000,
  )
}
