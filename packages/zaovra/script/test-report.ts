import { Parser } from "htmlparser2"

// Bun 1.3.14 omits suites for empty modules. Only compiler-proven empty runtime
// source can account for such a file; conditional tests/imports never qualify.
export function emptyModule(source: string) {
  return /^\s*(?:export\s*\{\s*\}\s*;?\s*)?$/.test(new Bun.Transpiler({ loader: "tsx" }).transformSync(source))
}

// Accept Bun's generated JUnit shape, including nested describe suites. Reject
// implied/missing XML closures so a truncated report cannot certify completion.
export function parseReport(xml: string) {
  const stack: string[] = []
  const files: { file: string; tests: number; observed: number }[] = []
  const totals = { tests: 0, failures: 0, skipped: 0, assertions: 0 }
  let root = false
  let closed = false
  let invalid = false
  let cases = 0
  let skipped = 0
  let failures = 0
  const integer = (value: string | undefined) => {
    if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      invalid = true
      return 0
    }
    return Number(value)
  }
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (closed) invalid = true
        if (
          ![
            "testsuites",
            "testsuite",
            "testcase",
            "skipped",
            "failure",
            "error",
            "system-out",
            "system-err",
            "properties",
            "property",
          ].includes(name)
        )
          invalid = true
        if (name === "testsuite" && !["testsuites", "testsuite"].includes(stack.at(-1) ?? "")) invalid = true
        if (["skipped", "failure", "error"].includes(name) && stack.at(-1) !== "testcase") invalid = true
        if (name === "testsuites") {
          if (root || stack.length) invalid = true
          root = true
          totals.tests = integer(attributes.tests)
          totals.failures = integer(attributes.failures)
          totals.skipped = integer(attributes.skipped)
          totals.assertions = integer(attributes.assertions)
        }
        if (name === "testsuite" && stack.at(-1) === "testsuites") {
          const file = attributes.file?.replaceAll("\\", "/") ?? ""
          if (!file || files.some((entry) => entry.file === file)) invalid = true
          files.push({ file, tests: integer(attributes.tests), observed: 0 })
        }
        if (name === "testcase") {
          const file = files.at(-1)
          if (stack.at(-1) !== "testsuite" || !file || attributes.file?.replaceAll("\\", "/") !== file.file) {
            invalid = true
          }
          if (file) file.observed++
          cases++
        }
        if (name === "skipped") skipped++
        if (name === "failure" || name === "error") failures++
        stack.push(name)
      },
      onclosetag(name, implied) {
        if ((implied && !xml.slice(parser.startIndex, parser.endIndex + 1).endsWith("/>")) || stack.pop() !== name)
          invalid = true
        if (name === "testsuites") closed = true
      },
      onerror() {
        invalid = true
      },
      ontext(text) {
        if (!stack.length && text.trim()) invalid = true
      },
      onprocessinginstruction(name) {
        if (name !== "?xml") invalid = true
      },
    },
    { xmlMode: true, decodeEntities: true },
  )
  parser.end(xml)
  if (
    invalid ||
    !root ||
    !closed ||
    stack.length ||
    totals.tests !== cases ||
    totals.skipped !== skipped ||
    files.some((file) => file.tests !== file.observed) ||
    totals.tests !== files.reduce((sum, file) => sum + file.tests, 0)
  )
    throw new Error("Incomplete or inconsistent JUnit report")
  return {
    ...totals,
    failures: Math.max(totals.failures, failures),
    files: files.map(({ file, tests }) => ({ file, tests })),
  }
}

export function reportExit(input: {
  expected: ReturnType<typeof parseReport>
  actual: ReturnType<typeof parseReport>
  exit: number
  signal: string | null
  unhandled?: boolean
}) {
  const expected = input.expected.files.toSorted((a, b) => a.file.localeCompare(b.file))
  const actual = input.actual.files.toSorted((a, b) => a.file.localeCompare(b.file))
  if (
    input.unhandled ||
    input.expected.failures ||
    input.actual.failures ||
    input.expected.tests !== input.actual.tests ||
    JSON.stringify(expected) !== JSON.stringify(actual)
  )
    return 1
  if (input.exit === 0 && !input.signal) return 0
  // A native crash stays nonzero in CI even when all registered tests have
  // durable passing results. Cancellation and deliberate exit132 never qualify.
  return input.signal && ["SIGILL", "SIGSEGV", "SIGABRT", "SIGBUS"].includes(input.signal) ? 2 : 1
}
