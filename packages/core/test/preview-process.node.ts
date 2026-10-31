import assert from "node:assert/strict"
import { readFile, writeFile, access, readdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { PreviewProcess } from "../src/preview-process"

const root = process.argv[2]
assert.ok(root, "A parent-owned temporary root is required")
const owner = { root, directory: root, sessionID: "node-session", jobID: "node-preview" }
const ready = path.join(root, "ready.json")
const server = `const http=require('node:http');const fs=require('node:fs');const server=http.createServer((req,res)=>res.end('node-preview-alive'));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({port:server.address().port})));`
let admitted!: () => void
const admission = new Promise<void>((resolve) => (admitted = resolve))
const completion = Effect.runPromise(
  PreviewProcess.run(
    ChildProcess.make(process.execPath, ["-e", server], { cwd: root, extendEnv: true }),
    owner,
    undefined,
    () => Effect.sync(admitted),
  ),
).then(
  (result) => ({ result }),
  (error: unknown) => ({ error }),
)
try {
  await Promise.race([
    admission,
    completion.then((result) => {
      throw new Error(`Preview ended before admission: ${JSON.stringify(result)}`)
    }),
  ])
  const deadline = Date.now() + 5000
  while (
    !(await access(ready).then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() >= deadline) throw new Error("Node HTTP preview was not ready")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const service = JSON.parse(await readFile(ready, "utf8")) as { port: number }
  const observe = () => fetch(`http://127.0.0.1:${service.port}`, { signal: AbortSignal.timeout(1500) })
  assert.equal(await (await observe()).text(), "node-preview-alive")
  assert.equal((await PreviewProcess.get(owner))?.status, "running")
  await assert.rejects(PreviewProcess.cancel({ ...owner, sessionID: "another-session" }), /another Session/)
  const record = path.join(
    root,
    "preview-processes",
    (await readdir(path.join(root, "preview-processes")))[0],
    "owner.json",
  )
  const original = await readFile(record)
  try {
    await writeFile(record, JSON.stringify({ ...JSON.parse(original.toString()), birth: "stale-node-identity" }))
    assert.equal((await PreviewProcess.cancel(owner))?.status, "unavailable")
    assert.equal(await (await observe()).text(), "node-preview-alive")
  } finally {
    await writeFile(record, original)
  }
  assert.equal((await PreviewProcess.cancel(owner))?.status, "cancelled")
  assert.equal(
    await observe().then(
      () => true,
      () => false,
    ),
    false,
  )
  console.log(
    JSON.stringify({
      node: process.versions.node,
      launch: true,
      query: true,
      staleBirthRefused: true,
      otherSessionRefused: true,
      cancelled: true,
      businessClosed: true,
    }),
  )
} finally {
  await PreviewProcess.cancel(owner)
  // The product poll is unref'ed so normal CLI exit can leave previews alive.
  // This standalone fixture must keep its event loop alive until that poll settles.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const settled = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Node preview drain did not settle after cancellation")), 5000)
      }),
    ])
    assert.equal("error" in settled, false)
  } finally {
    clearTimeout(timer)
  }
}
