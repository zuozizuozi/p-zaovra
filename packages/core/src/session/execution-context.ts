export * as ExecutionContext from "./execution-context"

import { createHash } from "node:crypto"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"

const names = Object.keys(SessionOutcome.ExecutionEnvironment.fields)

export function approved(
  messages: readonly { type: string; id: string; executionContract?: SessionOutcome.ExecutionContract }[],
) {
  const message = messages.findLast((item) => item.type === "user" && item.executionContract)
  return message?.executionContract ? { sourceMessageID: message.id, value: message.executionContract } : undefined
}

export function bind(context: SessionOutcome.ExecutionContext, contract: ReturnType<typeof approved>) {
  if (!contract) return context
  return {
    ...context,
    contract: {
      version: contract.value.version,
      sourceMessageID: contract.sourceMessageID,
      digest: digest(contract.value),
    },
    ...Object.fromEntries(
      (["entry", "cwd", "runtime", "timeout"] as const).map((name) => [
        name,
        {
          ...context[name],
          ...(contract.value[name] === undefined
            ? {}
            : { requested: { value: contract.value[name], source: "user" as const } }),
        },
      ]),
    ),
    environment: Object.fromEntries(
      names.map((name) => [
        name,
        {
          ...(context.environment[name as keyof SessionOutcome.ExecutionEnvironment] ?? {
            observed: { value: null, source: "unknown" as const },
          }),
          ...(contract.value.environment?.[name as keyof SessionOutcome.ExecutionEnvironment] === undefined
            ? {}
            : {
                requested: {
                  value: contract.value.environment[name as keyof SessionOutcome.ExecutionEnvironment],
                  source: "user" as const,
                },
              }),
        },
      ]),
    ),
  }
}

export function current(context: SessionOutcome.ExecutionContext | undefined, contract: ReturnType<typeof approved>) {
  if (!contract) return undefined
  return bind(
    capture(
      context?.entry.observed.value ?? "",
      context?.cwd.observed.value ?? "",
      Number(context?.timeout.observed.value ?? 0),
      false,
      { ...process.env, ...contract.value.environment },
    ),
    contract,
  )
}

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
  launchEnvironment: NodeJS.ProcessEnv = process.env,
  temporary: readonly string[] = [],
): SessionOutcome.ExecutionContext {
  const inherited = environment(launchEnvironment)
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
        return [
          name,
          !temporary.includes(name)
            ? inherited[name as keyof SessionOutcome.ExecutionEnvironment]
            : {
                requested: { value: launchEnvironment[name] ?? null, source: "diagnostic-temporary" as const },
                observed: { value: launchEnvironment[name] ?? null, source: "observed" as const },
              },
        ]
      }),
    ),
  }
}

export function digest(context: SessionOutcome.ExecutionContext | SessionOutcome.ExecutionContract) {
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
  if (!context) return current?.contract ? ["approved execution contract was not observed"] : []
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
  return [
    ...(current?.contract && context.contract?.digest !== current.contract.digest
      ? ["approved execution contract changed or was not bound"]
      : []),
    ...entries.flatMap(({ name, condition, current }) => {
      if (!condition) return []
      const requested = current?.requested ?? condition.requested
      if (requested?.source === "diagnostic-temporary")
        return [`${name}: diagnostic temporary condition is not the agreed execution contract`]
      if (condition.observed.source === "diagnostic-temporary" && requested?.source !== "user")
        return [`${name}: only diagnostic conditions were checked`]
      if (
        requested?.value !== undefined &&
        requested.value !== null &&
        (condition.observed.source === "unknown" || requested.value !== condition.observed.value)
      )
        return [`${name}: requested condition was not observed`]
      if (current && current.observed.source !== "unknown" && condition.observed.value !== current.observed.value)
        return [`${name}: execution environment changed`]
      return []
    }),
  ]
}
