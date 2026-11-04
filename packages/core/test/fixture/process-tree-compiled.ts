import { text } from "node:stream/consumers"
import { ProcessTree } from "@zaovra-ai/core/process-tree"

try {
  const command = process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh"
  const args =
    process.platform === "win32" ? ["/d", "/c", "echo compiled-owner623"] : ["-c", "printf compiled-owner623"]
  const owned = await ProcessTree.start(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env })
  const stdout = text(owned.proc.stdout!)
  const stderr = text(owned.proc.stderr!)
  const exit = await owned.closed
  console.log(JSON.stringify({ output: (await stdout).trim(), stderr: await stderr, exit, pid: owned.pid }))
} finally {
  await ProcessTree.shutdown()
}
