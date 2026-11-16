import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { link, mkdir, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { gradeBuild, gradePublish } from "../../../script/evaluation/memory/build-publish"
import { chains, prepare, change } from "../../../script/evaluation/memory/cases"
import { tmpdir } from "./fixture/tmpdir"

const turn = {
  admitted: true,
  promoted: true,
  active: false,
  pending: 0,
  assistants: 1,
  unsettled: 0,
  outcome: "completed" as const,
}

// These are adapter contract tests, not an implementation of the production trace collector.
const verified = async () => "verified" as const

test("build grades five real fixture states but requires host execution and prohibition evidence", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const chain = await prepare(directory, "build")
  const grade = (stage: number) => gradeBuild({ directory, stage, turn })
  expect((await grade(1)).pass).toBe(false)
  expect(() => run(directory, "build.cjs")).toThrow()
  expect(run(directory, "build.cjs", "web")).toContain("build ok")
  const first = await grade(1)
  expect(first.reason).toBe("needs-host-tool-evidence")
  expect(first.artifacts.find((item) => item.name === "dist/out.txt")?.artifact).toEqual({
    sha256: createHash("sha256").update("web:1.0.0").digest("hex"),
    bytes: 9,
  })
  expect((await gradeBuild({ directory, stage: 1, turn, verifyTools: verified })).pass).toBe(true)
  expect((await grade(2)).requirements).toEqual(["no-dist-commit"])
  expect((await gradeBuild({ directory, stage: 2, turn, verifyTools: verified })).pass).toBe(true)
  await writeFile(path.join(directory, "src/version.json"), JSON.stringify({ version: "1.1.0" }))
  expect((await grade(3)).reason).toBe("phase-artifacts-differ")
  run(directory, "build.cjs", "web")
  expect((await gradeBuild({ directory, stage: 3, turn, verifyTools: verified })).pass).toBe(true)
  await change(directory, "build")
  await writeFile(path.join(directory, "src/version.json"), JSON.stringify({ version: "1.2.0" }))
  expect((await grade(4)).pass).toBe(false)
  await rename(path.join(directory, "dist"), path.join(directory, "retired-dist"))
  expect((await grade(4)).reason).toBe("needs-host-tool-evidence")
  expect((await gradeBuild({ directory, stage: 4, turn, verifyTools: verified })).pass).toBe(true)
  await writeFile(path.join(directory, "retired-dist/out.txt"), "desktop:1.2.0")
  expect((await grade(4)).reason).toBe("phase-artifacts-differ")
  await writeFile(path.join(directory, "retired-dist/out.txt"), "web:1.1.0")
  await writeFile(path.join(directory, "build.cjs"), chain.seed["build.cjs"]!)
  expect((await grade(4)).pass).toBe(false)
  await writeFile(path.join(directory, "build.cjs"), chain.beforeFourth.write["build.cjs"]!)
  await writeFile(path.join(directory, "history.json"), JSON.stringify({ ...chain.history, initialTarget: "desktop" }))
  expect((await grade(5)).pass).toBe(false)
  await writeFile(path.join(directory, "history.json"), JSON.stringify(chain.history))
  expect((await gradeBuild({ directory, stage: 5, turn, verifyTools: verified })).pass).toBe(true)
  await mkdir(path.join(directory, "dist"))
  expect((await grade(5)).reason).toBe("unexpected-or-unsafe-workspace-artifact")
})

test("publish preserves old marker and renamed source; ordered validation cannot be inferred from markers", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const chain = await prepare(directory, "publish")
  const grade = (stage: number) => gradePublish({ directory, stage, turn })
  expect((await grade(1)).pass).toBe(false)
  expect(run(directory, "scripts/release.cjs")).toContain("published v1")
  expect((await grade(1)).reason).toBe("needs-host-tool-evidence")
  expect((await gradePublish({ directory, stage: 1, turn, verifyTools: verified })).pass).toBe(true)
  expect((await grade(2)).reason).toBe("artifact-only-phase-matches")
  expect((await grade(3)).pass).toBe(false)
  run(directory, "scripts/validate.cjs")
  run(directory, "scripts/release.cjs")
  expect((await grade(3)).requirements).toEqual(["every-release-v1-preceded-by-successful-validate"])
  expect((await gradePublish({ directory, stage: 3, turn, verifyTools: verified })).pass).toBe(true)
  await change(directory, "publish")
  expect((await grade(4)).pass).toBe(false)
  await rename(path.join(directory, "published.txt"), path.join(directory, "retired-published.txt"))
  run(directory, "scripts/validate.cjs")
  expect((await grade(4)).reason).toBe("needs-host-tool-evidence")
  expect((await gradePublish({ directory, stage: 4, turn, verifyTools: verified })).pass).toBe(true)
  await writeFile(
    path.join(directory, "history.json"),
    JSON.stringify({ reason: "network_timeout", check: "validate" }),
  )
  expect((await grade(5)).pass).toBe(false)
  await writeFile(path.join(directory, "history.json"), JSON.stringify(chain.history))
  expect((await gradePublish({ directory, stage: 5, turn, verifyTools: verified })).pass).toBe(true)
  await writeFile(path.join(directory, "scripts/release.cjs"), chain.seed["scripts/release.cjs"]!)
  expect((await grade(5)).reason).toBe("unexpected-or-unsafe-workspace-artifact")
  await unlink(path.join(directory, "scripts/release.cjs"))
  await writeFile(path.join(directory, "published.txt"), "v2")
  expect((await grade(5)).pass).toBe(false)
})

test("manually forged valid marker is insufficient; bad, missing and failed host evidence fail closed", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  await prepare(directory, "publish")
  await writeFile(path.join(directory, "published.txt"), "v1")
  const input = { directory, stage: 1, turn }
  expect((await gradePublish(input)).reason).toBe("needs-host-tool-evidence")
  expect((await gradePublish({ ...input, verifyTools: async () => "unknown" })).pass).toBe(false)
  expect((await gradePublish({ ...input, verifyTools: async () => "violated" })).reason).toBe(
    "host-tool-requirement-violated",
  )
  expect(
    (
      await gradePublish({
        ...input,
        verifyTools: async () => {
          throw new Error("private trace")
        },
      })
    ).reason,
  ).toBe("needs-host-tool-evidence")
  expect(
    (
      await gradePublish({
        ...input,
        verifyTools: () => {
          throw new Error("synchronous adapter error")
        },
      })
    ).reason,
  ).toBe("needs-host-tool-evidence")
  const result = await gradePublish({
    ...input,
    verifyTools: async (evidence) => {
      expect(evidence.chain).toBe("publish")
      expect(evidence.stage).toBe(1)
      expect(evidence.requirements).toEqual(["release-v1-executed"])
      expect(evidence.artifacts.every((item) => item.pass && item.artifact?.sha256.length === 64)).toBe(true)
      return "verified"
    },
  })
  expect(result.pass).toBe(true)
})

test("correct artifacts never override an incomplete turn or invalid stage", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  for (const grade of [gradeBuild, gradePublish]) {
    for (const change of [
      { outcome: "timeout" as const },
      { outcome: "stopped" as const },
      { outcome: "failed" as const },
      { outcome: "unknown" as const },
      { admitted: false },
      { promoted: false },
      { active: true },
      { pending: 1 },
      { unsettled: 1 },
      { assistants: 0 },
    ]) {
      expect(await grade({ directory, stage: 1, turn: { ...turn, ...change }, verifyTools: verified })).toEqual({
        pass: false,
        reason: "session-not-completed",
        artifacts: [],
      })
    }
    for (const stage of [0, 6, 1.5, NaN])
      await expect(grade({ directory, stage, turn })).rejects.toThrow("invalid-artifact-stage")
  }
})

test("source bypass, extra facts, oversized files, hard links and leaked reasons are rejected", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const chain = await prepare(directory, "build")
  await mkdir(path.join(directory, "dist"))
  await writeFile(path.join(directory, "dist/out.txt"), "web:1.0.0")
  const grade = () => gradeBuild({ directory, stage: 1, turn, verifyTools: verified })
  await writeFile(path.join(directory, "build.cjs"), "// bypass environment check\n")
  expect((await grade()).reason).toBe("phase-artifacts-differ")
  await writeFile(path.join(directory, "build.cjs"), chain.seed["build.cjs"]!)
  await writeFile(path.join(directory, "src/version.json"), JSON.stringify({ version: "1.0.0", pass: true }))
  expect((await grade()).pass).toBe(false)
  await writeFile(path.join(directory, "src/version.json"), chain.seed["src/version.json"]!)
  await writeFile(path.join(directory, "dist/out.txt"), "x".repeat(16385))
  expect((await grade()).artifacts.find((item) => item.name === "dist/out.txt")?.reason).toBe(
    "artifact-unreadable-or-oversized",
  )
  await writeFile(path.join(directory, "dist/out.txt"), "web:1.0.0")
  await link(path.join(directory, "dist/out.txt"), path.join(tmp.path, "outside.txt"))
  expect((await grade()).reason).toBe("unexpected-or-unsafe-workspace-artifact")
  await unlink(path.join(tmp.path, "outside.txt"))
  await writeFile(path.join(directory, "reason.txt"), "separate_signing")
  expect((await grade()).reason).toBe("unexpected-or-unsafe-workspace-artifact")
})

function run(directory: string, script: string, target?: string) {
  return execFileSync(process.execPath, [script], {
    cwd: directory,
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 65536,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP, TMP: process.env.TEMP } : {}),
      ...(target ? { BUILD_TARGET: target } : {}),
    },
  }).toString("utf8")
}
