import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "../fixture/tmpdir"

// Run the actual workflow shell, substituting only package commands. This tests orchestration,
// not another execution of the package suites or the browser/backend fixture.
for (const scenario of ["success", "unit-failure", "existing-root", "core-failure", "browser-failure"])
  test(`unit workflow preserves roots and original failure: ${scenario}`, async () => {
    await using tmp = await tmpdir()
    const workflow = Bun.YAML.parse(
      await Bun.file(path.resolve(import.meta.dir, "../../../../.github/workflows/test.yml")).text(),
    ) as {
      jobs: { unit: { steps: Array<{ name?: string; run?: string }> } }
    }
    const script = workflow.jobs.unit.steps.find((step) => step.name === "Run package unit tests")!.run!
    expect(script).toContain("set -euo pipefail")
    const bash =
      process.platform === "win32"
        ? path.resolve(Bun.spawnSync(["git", "--exec-path"]).stdout.toString().trim(), "../../../bin/bash.exe")
        : "bash"
    await Promise.all(
      ["core", "schema", "llm", "protocol", "client", "zaovra", "server", "session-ui", "app-ui"].map((name) =>
        fs.mkdir(path.join(tmp.path, "packages", name), { recursive: true }),
      ),
    )
    await Bun.write(path.join(tmp.path, "workflow.sh"), script)
    const child = Bun.spawn(
      [
        bash,
        "--noprofile",
        "--norc",
        "-c",
        `
set -euo pipefail
export ZAOVRA_766_TEST_ROOT="$PWD/profile"
export RUNNER_TEMP="$PWD"
export TRACE="$PWD/commands.tsv"
if [ "$SCENARIO" = existing-root ]; then
  mkdir -p "$ZAOVRA_766_TEST_ROOT"
  printf retained > "$ZAOVRA_766_TEST_ROOT/existing"
fi
bun() {
  local package
  package=$(basename "$PWD")
  printf '%s\t%s\t%s\n' "$package" "$*" "$ZAOVRA_766_TEST_ROOT" >> "$TRACE"
  if [ "$package" = core ]; then
    mkdir -p "$ZAOVRA_766_TEST_ROOT"
    printf retained > "$ZAOVRA_766_TEST_ROOT/core-evidence"
    if [ "$SCENARIO" = core-failure ]; then return 23; fi
  fi
  if [ "$*" = 'run test:unit' ] && [ "$SCENARIO" = unit-failure ]; then return 37; fi
  if [ "$*" = 'run test:browser' ]; then
    mkdir -p "$ZAOVRA_766_TEST_ROOT"
    printf browser > "$ZAOVRA_766_TEST_ROOT/browser-evidence"
    if [ "$SCENARIO" = browser-failure ]; then return 31; fi
  fi
  return 0
}
source ./workflow.sh
`,
      ],
      { cwd: tmp.path, env: { ...process.env, SCENARIO: scenario }, stdout: "pipe", stderr: "pipe" },
    )
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const trace = await Bun.file(path.join(tmp.path, "commands.tsv")).text()
      if (process.env.ZAOVRA_TEST_REPORT_DIR)
        await Bun.write(
          path.join(process.env.ZAOVRA_TEST_REPORT_DIR, `workflow-${scenario}.json`),
          JSON.stringify(
            {
              scenario,
              script,
              stdout,
              stderr,
              exit,
              trace,
              coreEvidence: await Bun.file(path.join(tmp.path, "profile-core/core-evidence")).exists(),
              rootRetained: await Bun.file(path.join(tmp.path, "profile/existing")).exists(),
            },
            null,
            2,
          ),
        )
      expect(exit, stdout + stderr).toBe(
        scenario === "unit-failure"
          ? 37
          : scenario === "existing-root"
            ? 1
            : scenario === "core-failure"
              ? 23
              : scenario === "browser-failure"
                ? 31
                : 0,
      )
      expect(await Bun.file(path.join(tmp.path, "profile-core/core-evidence")).text()).toBe("retained")
      expect(trace.split("\n")[0]).toMatch(/core\trun test\t.*\/profile-core$/)
      expect(trace.includes("app-ui\trun test:browser\t")).toBe(["success", "browser-failure"].includes(scenario))
      expect(trace.includes("app-ui\trun test:replay\t")).toBe(scenario === "success")
      if (scenario === "core-failure") {
        expect(trace.trim().split("\n")).toHaveLength(1)
        expect(stdout).not.toContain("app-ui-unit exit=")
        return
      }
      expect(stdout).toContain(`app-ui-unit exit=${scenario === "unit-failure" ? 37 : 0}`)
      if (scenario === "unit-failure") {
        expect(stdout).not.toContain("customization766-fresh-root exit=")
        return
      }
      expect(stdout).toContain(`customization766-fresh-root exit=${scenario === "existing-root" ? 1 : 0}`)
      if (scenario === "existing-root")
        expect(await Bun.file(path.join(tmp.path, "profile/existing")).text()).toBe("retained")
      if (scenario === "success") expect(trace.trim().split("\n")).toHaveLength(14)
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  }, 15000)
