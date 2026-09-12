import { expect, test } from "bun:test"
import { diagnosticFailures, formattingFailures } from "./formatting-failures"

test("keeps failed diagnostics separate from formatting and includes patch paths", () => {
  expect(diagnosticFailures({ lsp: { failed: ["typescript"] }, formatting: { failed: ["prettier"] } })).toEqual([
    "typescript",
  ])
  expect(
    diagnosticFailures({
      applied: [
        { resource: "a.ts", lsp: { failed: ["diagnostic timeout"] } },
        { resource: "b.ts", lsp: { failed: [] } },
      ],
    }),
  ).toEqual(["a.ts: diagnostic timeout"])
  for (const value of [undefined, {}, { lsp: null }, { lsp: { failed: [null, 1, ""] } }, { applied: [null, 1, {}] }])
    expect(diagnosticFailures(value)).toEqual([])
})

test("reads write/edit failures and per-file patch failures", () => {
  expect(formattingFailures({ formatting: { ran: [], failed: ["prettier"] } })).toEqual(["prettier"])
  expect(
    formattingFailures({
      applied: [
        { resource: "a.ts", formatting: { failed: ["prettier"] } },
        { resource: "b.ts", formatting: { failed: [] } },
      ],
    }),
  ).toEqual(["a.ts: prettier"])
})

test("ignores old metadata, successful formatting and malformed failure fields", () => {
  for (const value of [undefined, {}, { formatting: { failed: [] } }, { formatting: { failed: [null, 1, ""] } }]) {
    expect(formattingFailures(value)).toEqual([])
  }
})
