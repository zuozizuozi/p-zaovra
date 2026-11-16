import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { link, mkdir, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { gradeBuild, gradeBuildV2, gradePublish } from "../../../script/evaluation/memory/build-publish"
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

test("build-v2 keeps a separate CLI contract, five-stage oracle and historical cause", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const chain = await prepare(directory, "build-v2")
  const grade = (stage: number) => gradeBuildV2({ directory, stage, turn, verifyTools: verified })
  expect((await grade(1)).chain).toBe("build-v2")
  expect((await grade(1)).pass).toBe(false)
  // Even a correct inherited environment cannot satisfy this new CLI fixture.
  expect(() => run(directory, "build.cjs", "web")).toThrow()
  expect(() => run(directory, "build.cjs", undefined, ["--target", "desktop"])).toThrow()
  expect(() => run(directory, "build.cjs", undefined, ["--target", "web", "extra"])).toThrow()
  expect(run(directory, "build.cjs", undefined, ["--target", "web"])).toContain("build ok")
  expect((await gradeBuildV2({ directory, stage: 1, turn })).reason).toBe("needs-host-tool-evidence")
  const first = await gradeBuildV2({
    directory,
    stage: 1,
    turn,
    verifyTools: async (request) => {
      expect(request.chain).toBe("build-v2")
      expect(request.requirements).toEqual(["initial-E_TARGET-failure", "successful-web-build-1.0.0-without-bypass"])
      return "verified"
    },
  })
  expect(first.pass).toBe(true)
  expect((await gradeBuild({ directory, stage: 1, turn, verifyTools: verified })).pass).toBe(false)
  expect((await grade(2)).pass).toBe(true)
  await writeFile(path.join(directory, "src/version.json"), JSON.stringify({ version: "1.1.0" }))
  expect((await grade(3)).pass).toBe(false)
  run(directory, "build.cjs", undefined, ["--target", "web"])
  expect((await grade(3)).pass).toBe(true)
  await change(directory, "build-v2")
  await writeFile(path.join(directory, "src/version.json"), JSON.stringify({ version: "1.2.0" }))
  expect((await grade(4)).pass).toBe(false)
  await rename(path.join(directory, "dist"), path.join(directory, "retired-dist"))
  expect((await grade(4)).pass).toBe(true)
  expect((await grade(4)).requirements).toEqual(["no-build", "dist-renamed-to-retired-dist", "no-dist-commit"])
  await writeFile(
    path.join(directory, "history.json"),
    JSON.stringify({ ...chain.history, targetSource: "environment_variable" }),
  )
  expect((await grade(5)).pass).toBe(false)
  await writeFile(path.join(directory, "history.json"), JSON.stringify(chain.history))
  expect((await grade(5)).pass).toBe(true)
  expect(() => run(directory, "build.cjs", undefined, ["--target", "web"])).toThrow()
  // Actual desktop invocation is valid after the contract change, but forbidden in this phase.
  run(directory, "build.cjs", undefined, ["--target", "desktop"])
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

function run(directory: string, script: string, target?: string, args: readonly string[] = []) {
  return execFileSync(process.execPath, [script, ...args], {
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
