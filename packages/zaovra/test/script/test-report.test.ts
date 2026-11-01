import { expect, test } from "bun:test"
import { emptyModule, parseReport, reportExit } from "../../script/test-report"

test.each(["", "// no active tests", "export {}", "/* empty */\nexport {}"])(
  "compiler-proven empty module %s has no runtime tests",
  (source) => {
    expect(emptyModule(source)).toBe(true)
  },
)

test.each([
  'import "bun:test"',
  'if (false) test("hidden", () => {})',
  'test.skip("kept", () => {})',
  "export const value = 1",
])("executable source %s cannot excuse a missing suite", (source) => {
  expect(emptyModule(source)).toBe(false)
})

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="2" failures="0" skipped="1" assertions="1">
  <testsuite name="example" file="test/example.test.ts" tests="2">
    <testcase name="runs &amp; checks" file="test/example.test.ts" assertions="1" />
    <testsuite name="nested" file="test/example.test.ts" tests="1">
      <testcase name="already skipped" file="test/example.test.ts" assertions="0"><skipped /></testcase>
    </testsuite>
  </testsuite>
</testsuites>`
const expected = () =>
  parseReport(
    xml.replace('skipped="1"', 'skipped="2"').replace('assertions="1" />', 'assertions="0"><skipped /></testcase>'),
  )

test("Bun nested describe reports count each testcase once", () => {
  expect(parseReport(xml)).toEqual({
    tests: 2,
    failures: 0,
    skipped: 1,
    assertions: 1,
    files: [{ file: "test/example.test.ts", tests: 2 }],
  })
})

test.each([
  ["missing root closure", xml.replace("</testsuites>", "")],
  ["missing testcase closure", xml.replace("<skipped /></testcase>", "<skipped />")],
  ["root test mismatch", xml.replace('tests="2"', 'tests="3"')],
  ["file test mismatch", xml.replace('file="test/example.test.ts" tests="2"', 'file="test/example.test.ts" tests="1"')],
  ["skipped count mismatch", xml.replace('skipped="1"', 'skipped="0"')],
  ["missing test count", xml.replace('tests="2"', "")],
  ["negative test count", xml.replace('tests="2"', 'tests="-1"')],
  ["noninteger test count", xml.replace('tests="2"', 'tests="2.5"')],
  [
    "different testcase file",
    xml.replace(
      'name="runs &amp; checks" file="test/example.test.ts"',
      'name="runs &amp; checks" file="test/other.test.ts"',
    ),
  ],
  ["extra root", xml + xml],
  ["trailing non-XML data", xml + "interrupted report"],
  ["unexpected element", xml.replace("</testsuites>", "<unknown /></testsuites>")],
  ["DOCTYPE", '<!DOCTYPE testsuites [<!ENTITY unsafe "value">]>' + xml],
])("rejects %s before certifying completion", (_, report) => {
  expect(() => parseReport(report)).toThrow("Incomplete or inconsistent")
})

test("complete passing results and clean exit pass", () => {
  expect(reportExit({ expected: expected(), actual: parseReport(xml), exit: 0, signal: null })).toBe(0)
})

test.each(["SIGILL", "SIGSEGV", "SIGABRT", "SIGBUS"])(
  "complete reports with %s retain separate nonzero exit2",
  (signal) => {
    expect(reportExit({ expected: expected(), actual: parseReport(xml), exit: 132, signal })).toBe(2)
  },
)

test.each(["SIGINT", "SIGTERM", "SIGKILL"])("cancellation or external kill %s is a failure", (signal) => {
  expect(reportExit({ expected: expected(), actual: parseReport(xml), exit: 130, signal })).toBe(1)
})

test("exit132 without a native signal remains an ordinary failure", () => {
  expect(reportExit({ expected: expected(), actual: parseReport(xml), exit: 132, signal: null })).toBe(1)
})

test("an uncaught module error omitted by JUnit cannot become a shutdown-only crash", () => {
  expect(
    reportExit({ expected: expected(), actual: parseReport(xml), exit: 132, signal: "SIGILL", unhandled: true }),
  ).toBe(1)
})

test("a complete but failing result remains failed even with a native signal", () => {
  const actual = parseReport(xml.replace('failures="0"', 'failures="1"'))
  expect(reportExit({ expected: expected(), actual, exit: 132, signal: "SIGILL" })).toBe(1)
})

test("a missing file or different registered count remains a failure", () => {
  const actual = parseReport(xml)
  expect(
    reportExit({
      expected: { ...expected(), files: [...actual.files, { file: "test/missing.test.ts", tests: 1 }], tests: 3 },
      actual,
      exit: 132,
      signal: "SIGILL",
    }),
  ).toBe(1)
  expect(
    reportExit({
      expected: { ...expected(), files: [{ file: actual.files[0].file, tests: 3 }], tests: 3 },
      actual,
      exit: 0,
      signal: null,
    }),
  ).toBe(1)
})
