export * as ExecutionContext from "./execution-context"

import { createHash } from "node:crypto"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"

const names = Object.keys(SessionOutcome.ExecutionEnvironment.fields)

export function environment(env: NodeJS.ProcessEnv = process.env): SessionOutcome.ExecutionEnvironment {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        observed: { value: env[name] ?? null, source: "default" as const },
      },
    ]),
  )
}

// Captured by the host at launch. A shell command is not proof of the invoked
// program's runtime version or effective worker count; those remain unknown.
export function capture(
  command: string,
  cwd: string,
  timeout: number,
  explicitTimeout: boolean,
): SessionOutcome.ExecutionContext {
  const inherited = environment()
  return {
    entry: { observed: { value: command, source: "observed" } },
    cwd: { observed: { value: cwd, source: "observed" } },
    runtime: { observed: { value: null, source: "unknown" } },
    timeout: {
      ...(explicitTimeout ? { requested: { value: String(timeout), source: "unknown" as const } } : {}),
      observed: { value: String(timeout), source: explicitTimeout ? "observed" : "default" },
    },
    environment: Object.fromEntries(
      names.map((name) => {
        const assigned = command.match(
          new RegExp(`(?:^|[\\s;])(?:\\$env:)?${name}\\s*=\\s*["']?([^\\s;"']+)`, "i"),
        )?.[1]
        return [
          name,
          assigned === undefined
            ? inherited[name as keyof SessionOutcome.ExecutionEnvironment]
            : {
                requested: { value: assigned, source: "diagnostic-temporary" as const },
                observed: { value: null, source: "unknown" as const },
              },
        ]
      }),
    ),
  }
}

export function digest(context: SessionOutcome.ExecutionContext) {
  return createHash("sha256")
    .update(
      JSON.stringify(context, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest("hex")
}

export function problems(
  context: SessionOutcome.ExecutionContext | undefined,
  current?: SessionOutcome.ExecutionContext,
) {
  if (!context) return []
  const now = current?.environment ?? environment()
  const entries = [
    ...(["entry", "cwd", "runtime", "timeout"] as const).map((name) => ({
      name,
      condition: context[name],
      current: current?.[name],
    })),
    ...names.map((name) => ({
      name,
      condition: context.environment[name as keyof SessionOutcome.ExecutionEnvironment],
      current: now[name as keyof SessionOutcome.ExecutionEnvironment],
    })),
  ]
  return entries.flatMap(({ name, condition, current }) => {
    if (!condition) return []
    if (condition.requested?.source === "diagnostic-temporary")
      return [`${name}: diagnostic temporary condition is not the agreed execution contract`]
    if (condition.observed.source === "diagnostic-temporary" && condition.requested?.source !== "user")
      return [`${name}: only diagnostic conditions were checked`]
    if (
      condition.requested?.value !== undefined &&
      condition.requested.value !== null &&
      (condition.observed.source === "unknown" || condition.requested.value !== condition.observed.value)
    )
      return [`${name}: requested condition was not observed`]
    if (current && "observed" in current && condition.observed.value !== current.observed.value)
      return [`${name}: execution environment changed`]
    return []
  })
}
