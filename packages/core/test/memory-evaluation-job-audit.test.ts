import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

const controller = path.resolve(import.meta.dir, "../../../script/evaluation/memory/windows-job.py")
const nativeObserver = `
import ctypes, json, sys, time
from ctypes import wintypes
native = ctypes.WinDLL('kernel32', use_last_error=True)
native.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
native.OpenProcess.restype = wintypes.HANDLE
native.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
native.WaitForSingleObject.restype = wintypes.DWORD
native.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
native.CloseHandle.argtypes = [wintypes.HANDLE]
handles = []
try:
    pids = json.loads(sys.argv[1])
    for pid in pids:
        handle = native.OpenProcess(0x101000, False, pid)
        if not handle: raise ctypes.WinError(ctypes.get_last_error())
        handles.append(handle)
    before = [native.WaitForSingleObject(handle, 0) for handle in handles]
    print(json.dumps({'event':'held', 'pids':pids, 'before':before}), flush=True)
    started = time.monotonic()
    waited = [native.WaitForSingleObject(handle, 8000) for handle in handles[:2]]
    codes = []
    for handle in handles[:2]:
        code = wintypes.DWORD()
        if not native.GetExitCodeProcess(handle, ctypes.byref(code)): raise ctypes.WinError(ctypes.get_last_error())
        codes.append(code.value)
    print(json.dumps({'event':'observed', 'pids':pids, 'waited':waited, 'codes':codes,
                     'outsideAlive':native.WaitForSingleObject(handles[2],0)==258,
                     'elapsedMs':round((time.monotonic()-started)*1000)}), flush=True)
finally:
    for handle in handles: native.CloseHandle(handle)
`
const rootScript = `
import json, os, pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
pathlib.Path('tree.tmp').write_text(json.dumps({'root':os.getpid(),'child':child.pid}), encoding='utf-8')
os.replace('tree.tmp', 'tree.json')
time.sleep(60)
`

function lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return {
    reader,
    async read() {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          (async () => {
            while (true) {
              const end = buffer.indexOf("\n")
              if (end !== -1) {
                const line = buffer.slice(0, end)
                buffer = buffer.slice(end + 1)
                return JSON.parse(line) as Record<string, unknown>
              }
              const next = await reader.read()
              if (next.done) throw new Error("native-observer-ended-before-evidence")
              buffer += decoder.decode(next.value, { stream: true })
              if (buffer.length > 65536) throw new Error("native-evidence-over-limit")
            }
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("native-evidence-timeout")), 10000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

for (const mode of ["backpressure", "controller-exit"] as const)
  test.skipIf(process.platform !== "win32")(
    `independent original handles confirm owned tree exits under ${mode}`,
    async () => {
      await using temp = await tmpdir()
      const python = Bun.which("python")
      if (!python) throw new Error("Native handle audit needs host Python")
      const outside = Bun.spawn([python, "-c", "import time; time.sleep(60)"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      const started = Date.now()
      const control = Bun.spawn(
        [
          python,
          controller,
          "--cwd",
          temp.path,
          "--log",
          path.join(temp.path, "child.log"),
          "--seconds",
          mode === "backpressure" ? "3" : "20",
          "--",
          python,
          "-c",
          rootScript,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      const controlLines = lines(control.stdout)
      const controlErrors = new Response(control.stderr).text()
      try {
        const ready = await controlLines.read()
        expect(ready.event).toBe("started")
        const deadline = Date.now() + 2000
        while (!(await Bun.file(path.join(temp.path, "tree.json")).exists()) && Date.now() < deadline)
          await Bun.sleep(10)
        const tree = await Bun.file(path.join(temp.path, "tree.json")).json()
        expect(tree.root).toBe(ready.pid)
        const observer = Bun.spawn(
          [python, "-c", nativeObserver, JSON.stringify([tree.root, tree.child, outside.pid])],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        )
        const observerLines = lines(observer.stdout)
        const observerErrors = new Response(observer.stderr).text()
        try {
          // These handles are opened while all three processes are still alive; none is reopened by PID after exit.
          expect(await observerLines.read()).toMatchObject({ event: "held", before: [258, 258, 258] })
          if (mode === "backpressure") {
            // After the started reply, never drain controller stdout again.
            control.stdin.write((JSON.stringify({ op: "inspect", nonce: "x".repeat(128) }) + "\n").repeat(5000))
          } else control.kill()
          const proof = await observerLines.read()
          expect(proof).toMatchObject({ event: "observed", waited: [0, 0], outsideAlive: true })
          expect(await observer.exited).toBe(0)
          const exit = await control.exited
          if (mode === "backpressure") expect(exit).toBe(124)
          expect(Date.now() - started).toBeLessThan(mode === "backpressure" ? 9000 : 6000)
          expect(outside.exitCode).toBeNull()
          console.log(JSON.stringify({ mode, controllerExit: exit, elapsedMs: Date.now() - started, proof }))
        } finally {
          if (observer.exitCode === null) observer.kill()
          await observer.exited
          await observerLines.reader.cancel()
          expect(await observerErrors).toBe("")
        }
      } finally {
        control.stdin.end()
        if (control.exitCode === null) control.kill()
        await control.exited
        await controlLines.reader.cancel()
        if (outside.exitCode === null) outside.kill()
        await outside.exited
        expect(await controlErrors).toBe("")
      }
    },
    20000,
  )
