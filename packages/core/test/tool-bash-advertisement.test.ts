import { expect, test } from "bun:test"
import { Schema } from "effect"
import { BashTool } from "../src/tool/bash"

test("K08 legacy explicit bash calls retain verification and environment execution fields", () => {
  const legacy = {
    command: "run-the-existing-check",
    workdir: "fixture",
    timeout: 1000,
    hard_timeout_ms: 5000,
    background_kind: "task",
    run_in_background: false,
    verification: "test",
    verification_report: true,
    verification_requirements: ["Existing user requirement"],
    verification_targets: ["source.ts", "assertion.ts"],
    verification_assertions: ["assertion.ts"],
    verification_replaces: ["prior-check"],
    verification_sample: "fixture-sample",
    environment: { OMP_NUM_THREADS: "2" },
  } satisfies typeof BashTool.Input.Type
  expect(Schema.decodeUnknownSync(BashTool.Input)(legacy)).toEqual(legacy)
})
