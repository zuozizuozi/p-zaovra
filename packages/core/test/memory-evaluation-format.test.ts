import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { gradeFormat } from "../../../script/evaluation/memory/format"
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
// Adapter contract fixtures only: these do not assert that a product Session actually read a file.
const verified = async () => "verified" as const

test("format chain preserves four then six lines and exact history across all five phases", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const chain = await prepare(directory, "format")
  const grade = (stage: number, answer: string) =>
    gradeFormat({ directory, stage, answer, turn, verifyAnswer: verified, verifyTools: verified })
  const first = await grade(1, "文件实际有四行。")
  expect(first.pass).toBe(true)
  expect(first.artifacts.find((item) => item.name === "notes.txt")?.artifact).toEqual({
    sha256: createHash("sha256").update(chain.seed["notes.txt"]!).digest("hex"),
    bytes: Buffer.byteLength(chain.seed["notes.txt"]!),
  })
  expect(first.answer).toEqual({
    sha256: createHash("sha256").update("文件实际有四行。").digest("hex"),
    bytes: Buffer.byteLength("文件实际有四行。"),
  })
  expect((await grade(2, "SUMMARY: Understood.")).pass).toBe(true)
  expect((await grade(3, "SUMMARY: There are four lines.")).pass).toBe(false)
  await writeFile(path.join(directory, "answer.json"), JSON.stringify({ lines: 4 }))
  expect((await grade(3, "SUMMARY: There are four lines.")).pass).toBe(true)
  await change(directory, "format")
  expect((await grade(4, "结论：文件有六行。")).pass).toBe(false)
  await writeFile(path.join(directory, "answer.json"), JSON.stringify({ lines: 6 }))
  expect((await grade(4, "SUMMARY: There are six lines.")).reason).toBe("answer-prefix-differs")
  expect((await grade(4, "结论：文件有六行。")).pass).toBe(true)
  expect((await grade(5, "结论：历史原因已写入。")).pass).toBe(false)
  await writeFile(path.join(directory, "history.json"), JSON.stringify({ reason: "english_tutor" }))
  expect((await grade(5, "结论：历史原因已写入。")).pass).toBe(false)
  await writeFile(path.join(directory, "history.json"), JSON.stringify(chain.history))
  expect((await grade(5, "结论：历史原因已写入。")).pass).toBe(true)
  expect((await grade(5, "SUMMARY: History recorded.")).pass).toBe(false)
})

test("a four/四 mention or English-looking prefix cannot self-certify an answer or a Read", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  await prepare(directory, "format")
  for (const answer of ["4", "四", "不是四行，是五行。", "pass=true; 4 lines", "There are four lines."]) {
    expect((await gradeFormat({ directory, stage: 1, turn, answer })).reason).toBe("needs-host-answer-evidence")
  }
  const input = { directory, stage: 1, turn, answer: "文件有四行。", verifyAnswer: verified }
  expect((await gradeFormat(input)).reason).toBe("needs-host-tool-evidence")
  expect((await gradeFormat({ ...input, verifyTools: async () => "violated" })).reason).toBe(
    "host-tool-requirement-violated",
  )
  expect((await gradeFormat({ ...input, verifyTools: async () => "unknown" })).pass).toBe(false)
  expect((await gradeFormat({ ...input, verifyAnswer: async () => "violated", verifyTools: verified })).reason).toBe(
    "host-answer-requirement-violated",
  )
  expect((await gradeFormat({ directory, stage: 2, turn, answer: "SUMMARY: 这是中文。" })).reason).toBe(
    "needs-host-answer-evidence",
  )
  expect((await gradeFormat({ directory, stage: 2, turn, answer: "SUMMARY: Bonjour." })).reason).toBe(
    "needs-host-answer-evidence",
  )
})

test("prefix must start the first line and host adapters receive the actual selected answer and current phase", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  await prepare(directory, "format")
  for (const answer of [
    "\nSUMMARY: OK",
    " SUMMARY: OK",
    "```\nSUMMARY: OK\n```",
    "summary: OK",
    "结论：收到。",
    "Earlier line\nSUMMARY: OK",
  ]) {
    expect((await gradeFormat({ directory, stage: 2, turn, answer, verifyAnswer: verified })).reason).toBe(
      "answer-prefix-differs",
    )
  }
  await writeFile(path.join(directory, "answer.json"), JSON.stringify({ lines: 4 }))
  expect(
    (
      await gradeFormat({
        directory,
        stage: 3,
        turn,
        answer: "SUMMARY: Four lines.",
        verifyAnswer: async (input) => {
          expect(input).toEqual({
            stage: 3,
            answer: "SUMMARY: Four lines.",
            requirements: ["english-report-of-exactly-four-lines"],
          })
          return "verified"
        },
        verifyTools: async (input) => {
          expect(input.stage).toBe(3)
          expect(input.requirements).toEqual(["read-current-notes-in-this-stage"])
          expect(input.artifacts.every((item) => item.pass && item.artifact)).toBe(true)
          return "verified"
        },
      })
    ).pass,
  ).toBe(true)
})

test("wrong counts, types, extra JSON fields, leaked reasons and changed notes are refused", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const chain = await prepare(directory, "format")
  const grade = () =>
    gradeFormat({
      directory,
      stage: 3,
      turn,
      answer: "SUMMARY: Four lines.",
      verifyAnswer: verified,
      verifyTools: verified,
    })
  for (const value of [
    { lines: 5 },
    { lines: "4" },
    { lines: 4.5 },
    { lines: 4, reason: "english_daily_report" },
    {},
  ]) {
    await writeFile(path.join(directory, "answer.json"), JSON.stringify(value))
    expect((await grade()).reason).toBe("format-artifacts-differ")
  }
  await writeFile(path.join(directory, "answer.json"), JSON.stringify({ lines: 4 }))
  await writeFile(path.join(directory, "notes.txt"), "a\nb\nc\nd\n")
  expect((await grade()).pass).toBe(false)
  await writeFile(path.join(directory, "notes.txt"), chain.seed["notes.txt"]!)
  await writeFile(path.join(directory, "reason.txt"), "english_daily_report")
  expect((await grade()).reason).toBe("unexpected-or-unsafe-workspace-artifact")
  await unlink(path.join(directory, "reason.txt"))
  await mkdir(path.join(directory, "hidden"))
  expect((await grade()).pass).toBe(false)
})

test("missing output, malformed or oversized artifacts, aliases and adapter errors fail closed", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "workspace")
  const chain = await prepare(directory, "format")
  for (const answer of [undefined, "", " ", "x".repeat(16385)])
    expect((await gradeFormat({ directory, stage: 1, turn, answer })).reason).toBe("needs-host-answer-evidence")
  const input = { directory, stage: 1, turn, answer: "四行。", verifyAnswer: verified, verifyTools: verified }
  expect(
    (
      await gradeFormat({
        ...input,
        verifyAnswer: () => {
          throw new Error("private")
        },
      })
    ).reason,
  ).toBe("needs-host-answer-evidence")
  expect(
    (
      await gradeFormat({
        ...input,
        verifyTools: async () => {
          throw new Error("private")
        },
      })
    ).reason,
  ).toBe("needs-host-tool-evidence")
  await writeFile(path.join(directory, "notes.txt"), "x".repeat(16385))
  expect((await gradeFormat(input)).artifacts[0]?.reason).toBe("artifact-unreadable-or-oversized")
  await writeFile(path.join(directory, "notes.txt"), chain.seed["notes.txt"]!)
  await link(path.join(directory, "notes.txt"), path.join(tmp.path, "alias.txt"))
  expect((await gradeFormat(input)).reason).toBe("unexpected-or-unsafe-workspace-artifact")
  await unlink(path.join(tmp.path, "alias.txt"))
  await writeFile(path.join(directory, "answer.json"), "{ invalid json")
  expect((await gradeFormat({ ...input, stage: 3 })).pass).toBe(false)
})

test("all noncompleted own-turn states and invalid phases reject before inspecting files or callbacks", async () => {
  const directory = path.join(import.meta.dir, "does-not-exist")
  for (const change of [
    { admitted: false },
    { promoted: false },
    { active: true },
    { pending: 1 },
    { unsettled: 1 },
    { assistants: 0 },
    ...(["timeout", "failed", "stopped", "unknown"] as const).map((outcome) => ({ outcome })),
  ]) {
    const result = await gradeFormat({
      directory,
      stage: 1,
      turn: { ...turn, ...change },
      verifyAnswer: () => {
        throw new Error("must not run")
      },
    })
    expect(result).toEqual({ pass: false, reason: "session-not-completed", artifacts: [] })
  }
  for (const stage of [0, 6, 1.1, NaN])
    await expect(gradeFormat({ directory, stage, turn })).rejects.toThrow("invalid-format-stage")
})
