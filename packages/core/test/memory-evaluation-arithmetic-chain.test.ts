import { expect, test } from "bun:test"
import { link, mkdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { gradeArithmetic } from "../../../script/evaluation/memory/arithmetic-chain"
import { change, prepare } from "../../../script/evaluation/memory/cases"
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
const verified = async () => "verified" as const // Host contract stub, not proof a model ran a command.
const multiply = "exports.add=(a,b)=>a+b;exports.mul=(a,b)=>a*b\n"
const subtract = multiply + "exports.sub=(a,b)=>a-b\n"

test("arithmetic phases preserve seeds, execute behavior and retain history-only source fingerprints", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const chain = await prepare(directory, "arithmetic")
  const input = { directory, turn, executable: process.execPath, verifyTools: verified }
  expect((await gradeArithmetic({ ...input, stage: 1 })).pass).toBe(true)
  expect((await gradeArithmetic({ ...input, stage: 2 })).pass).toBe(true)
  await writeFile(path.join(directory, "src/sum.cjs"), multiply)
  expect((await gradeArithmetic({ ...input, stage: 3 })).reason).toBe("tests-not-extended")
  await writeFile(
    path.join(directory, "test/sum.test.cjs"),
    chain.seed["test/sum.test.cjs"] + 'test("mul",()=>assert.equal(app.mul(2,3),6))\n',
  )
  const third = await gradeArithmetic({ ...input, stage: 3 })
  expect(third.pass).toBe(true)
  await change(directory, "arithmetic")
  await writeFile(path.join(directory, "src/sum.cjs"), subtract)
  expect((await gradeArithmetic({ ...input, stage: 4 })).reason).toBe("needs-previous-stage-artifacts")
  expect((await gradeArithmetic({ ...input, stage: 4, previousArtifacts: third.artifacts })).reason).toBe(
    "tests-not-extended",
  )
  await writeFile(
    path.join(directory, "test/math.test.cjs"),
    chain.seed["test/sum.test.cjs"] +
      'test("mul",()=>assert.equal(app.mul(2,3),6));test("sub",()=>assert.equal(app.sub(2,3),-1))\n',
  )
  const fourth = await gradeArithmetic({ ...input, stage: 4, previousArtifacts: third.artifacts })
  expect(fourth.pass).toBe(true)
  await writeFile(path.join(directory, "history.json"), JSON.stringify(chain.history))
  expect((await gradeArithmetic({ ...input, stage: 5 })).reason).toBe("needs-previous-stage-artifacts")
  expect((await gradeArithmetic({ ...input, stage: 5, previousArtifacts: fourth.artifacts })).pass).toBe(true)
  await writeFile(path.join(directory, "src/sum.cjs"), subtract + "// unrelated change\n")
  expect((await gradeArithmetic({ ...input, stage: 5, previousArtifacts: fourth.artifacts })).reason).toBe(
    "history-phase-changed-code",
  )
  await writeFile(path.join(directory, "src/sum.cjs"), subtract)
  await writeFile(path.join(directory, "history.json"), JSON.stringify({ reason: "faster_startup" }))
  expect((await gradeArithmetic({ ...input, stage: 5, previousArtifacts: fourth.artifacts })).reason).toBe(
    "historical-facts-differ",
  )
})

test("correct artifacts do not certify actual commands, changed tests or absence of npm/install", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  await prepare(directory, "arithmetic")
  const input = { directory, turn, executable: process.execPath, stage: 1 }
  expect((await gradeArithmetic(input)).reason).toBe("needs-host-tool-evidence")
  expect((await gradeArithmetic({ ...input, verifyTools: async () => "violated" })).reason).toBe(
    "host-tool-requirement-violated",
  )
  expect(
    (
      await gradeArithmetic({
        ...input,
        verifyTools: () => {
          throw new Error("private")
        },
      })
    ).reason,
  ).toBe("needs-host-tool-evidence")
  await writeFile(path.join(directory, "src/sum.cjs"), multiply)
  await writeFile(path.join(directory, "test/sum.test.cjs"), "// changed but not a test\n")
  expect((await gradeArithmetic({ ...input, stage: 3 })).reason).toBe("needs-host-tool-evidence")
  expect(
    (
      await gradeArithmetic({
        ...input,
        stage: 3,
        verifyTools: async ({ requirements }) => {
          expect(requirements).toContain("added-tests-exercise-mul")
          expect(requirements).toContain("no-npm-test")
          return "violated"
        },
      })
    ).pass,
  ).toBe(false)
  await writeFile(path.join(directory, "src/sum.cjs"), "exports.add=(a,b)=>a+b;exports.mul=(a,b)=>a+b\n")
  expect((await gradeArithmetic({ ...input, stage: 3, verifyTools: verified })).reason).toBe(
    "artifact-or-behavior-failed",
  )
})

test("extra, renamed-old, oversized, aliased and prematurely changed fixture files are refused", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const chain = await prepare(directory, "arithmetic")
  const input = { directory, turn, executable: process.execPath, stage: 2 }
  await writeFile(path.join(directory, "reason.txt"), "npm_old_generator")
  expect((await gradeArithmetic(input)).reason).toBe("unexpected-or-unsafe-artifact")
  await unlink(path.join(directory, "reason.txt"))
  await writeFile(path.join(directory, "src/sum.cjs"), multiply)
  expect((await gradeArithmetic(input)).reason).toBe("arithmetic-artifacts-differ")
  await writeFile(path.join(directory, "src/sum.cjs"), chain.seed["src/sum.cjs"]!)
  await link(path.join(directory, "src/sum.cjs"), path.join(tmp.path, "alias.cjs"))
  expect((await gradeArithmetic(input)).reason).toBe("unexpected-or-unsafe-artifact")
  await unlink(path.join(tmp.path, "alias.cjs"))
  await writeFile(path.join(directory, "README.md"), "x".repeat(16385))
  expect((await gradeArithmetic(input)).reason).toBe("unexpected-or-unsafe-artifact")
  await writeFile(path.join(directory, "README.md"), chain.seed["README.md"]!)
  await change(directory, "arithmetic")
  await writeFile(path.join(directory, "test/sum.test.cjs"), chain.seed["test/sum.test.cjs"]!)
  expect((await gradeArithmetic({ ...input, stage: 4 })).reason).toBe("unexpected-or-unsafe-artifact")
  await unlink(path.join(directory, "test/sum.test.cjs"))
  await mkdir(path.join(directory, "node_modules"))
  expect((await gradeArithmetic({ ...input, stage: 4 })).reason).toBe("unexpected-or-unsafe-artifact")
})

test("oracle refuses code that mutates files and noncompleted turns without executing them", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  await prepare(directory, "arithmetic")
  const input = { directory, turn, executable: process.execPath, stage: 3, verifyTools: verified }
  await writeFile(path.join(directory, "test/sum.test.cjs"), "// test evidence checked separately\n")
  await writeFile(
    path.join(directory, "src/sum.cjs"),
    multiply + 'require("node:fs").writeFileSync("unexpected.txt","side effect")\n',
  )
  expect((await gradeArithmetic({ ...input, turn: { ...turn, outcome: "stopped" } })).reason).toBe(
    "session-not-completed",
  )
  expect(await Bun.file(path.join(directory, "unexpected.txt")).exists()).toBe(false)
  expect((await gradeArithmetic(input)).reason).toBe("artifact-changed-during-oracle")
  for (const stage of [0, 6, NaN])
    await expect(gradeArithmetic({ ...input, stage })).rejects.toThrow("invalid-arithmetic-stage")
})
