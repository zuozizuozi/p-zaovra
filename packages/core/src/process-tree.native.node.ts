export * as ProcessTreeNative from "./process-tree.native.node"

export type Identity = { pid: number; ppid: number; birth: string }

// No PID-based imitation of the CLI native pidfd/HANDLE protection on Node.
// ProcessTree.supported() preserves the existing Node spawner lifecycle.
export async function identity(_pid: number): Promise<Identity | undefined> {
  throw new Error("Native tool process-tree ownership requires Bun on Windows or Linux")
}

export async function signal(_item: Identity, _signal: NodeJS.Signals): Promise<void> {
  throw new Error("Native tool process-tree ownership requires Bun on Windows or Linux")
}

export async function createJob(): Promise<{
  name: string
  members(): number[]
  verify(pid: number): void
  stop(): Promise<void>
}> {
  throw new Error("Native tool process ownership requires Bun on Windows or Linux")
}

export async function installSubreaper(): Promise<void> {
  throw new Error("Native tool process ownership requires Bun on Linux")
}
