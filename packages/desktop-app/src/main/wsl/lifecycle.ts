import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"

// Keep stdin open after sending this compound command. EOF also cleans up the
// Linux server when the Windows launcher disappears unexpectedly.
export function wslSidecarScript(command: string) {
  const scope = `ZAOVRA_DESKTOP_PROCESS_SCOPE=${randomUUID()}`
  return `{
set -eu
(
export ${scope}
${command}
) &
server_pid=$!
(read -r control || true) <&0 &
monitor_pid=$!
owned_processes() {
  for entry in /proc/[0-9]*; do
    if grep -zFxq '${scope}' "$entry/environ" 2>/dev/null; then printf '%s\\n' "\${entry##*/}"; fi
  done
}
cleanup() {
  trap - EXIT
  kill "$monitor_pid" 2>/dev/null || true
  kill -TERM "$server_pid" 2>/dev/null || true
  owned=$(owned_processes)
  if [ -n "$owned" ]; then kill -TERM $owned 2>/dev/null || true; fi
  deadline=$((SECONDS + 6))
  while [ -n "$(owned_processes)" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.1; done
  owned=$(owned_processes)
  if [ -n "$owned" ]; then kill -KILL $owned 2>/dev/null || true; fi
  kill -KILL "$server_pid" 2>/dev/null || true
  wait "$server_pid" "$monitor_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
wait -n "$server_pid" "$monitor_pid"
}
`
}

export function createWslStop(child: ChildProcessWithoutNullStreams) {
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
  let pending: Promise<void> | undefined
  return () => {
    if (pending) return pending
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    child.stdin.end()
    pending = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending = undefined
        reject(new Error("WSL server did not stop within 10 seconds"))
      }, 10_000)
      void exited.then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
    return pending
  }
}
