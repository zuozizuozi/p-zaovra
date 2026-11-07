import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

// This boundary is also run by the trusted workflow checkout before either publish path.
export function requireMainPath(report, source, installerSHA256) {
  assert.equal(report.schema, 1, "main-path report schema")
  assert.match(source, /^[0-9a-f]{40}$/, "exact source SHA")
  assert.equal(report.source, source, "main-path source identity")
  assert.match(installerSHA256, /^[0-9a-f]{64}$/, "actual installer digest")
  assert.equal(report.installerSHA256, installerSHA256, "main-path installer identity")
  assert.equal(report.scope, "A2.1-6", "required main-path scope")
  assert.equal(report.runtime?.packaged, true, "actual packaged runtime")
  assert.equal(report.closed, true, "test instance cleanup")
  assert.equal(report.exit?.code, 0, "test app exited cleanly")
  assert.equal(report.exit?.signal, null, "test app was not killed")
  assert.deepEqual(report.pageErrors, [], "no renderer errors")
  assert.equal(report.providerError, undefined, "fixed provider completed")
  assert.equal(report.paidModelCalls, 0, "no paid model calls")
  assert.equal(report.steps?.length, 6, "all six steps required")
  for (const id of [1, 2, 3, 4, 5, 6]) {
    const steps = report.steps.filter((step) => step.id === id)
    assert.equal(steps.length, 1, "one result for step " + id)
    assert.equal(steps[0].status, "pass", "main-path step " + id)
  }
  assert.equal(report.steps.find((step) => step.id === 1).installation, "verified", "real installation required")
  assert.equal(report.steps.find((step) => step.id === 2).upgrade, "verified", "real in-app upgrade required")
  assert(report.screenshots?.length >= 6, "reviewable main-path screenshots")
  return report
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(process.argv[4])) hash.update(chunk)
  requireMainPath(JSON.parse(await readFile(process.argv[2], "utf8")), process.argv[3], hash.digest("hex"))
  console.log("All six packaged main-path steps and installer/source identity verified")
}
