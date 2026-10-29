export namespace Feedback {
  export type Event = { at: number; kind: string; state: string }
  export type Context = {
    version?: string
    platform?: string
    provider?: string
    model?: string
    events?: Event[]
    errors?: { at: number; status?: number; category?: string }[]
  }
  export type Snapshot = Readonly<{
    text: string
    files: readonly Readonly<{ name: string; text: string }>[]
    image?: string
  }>

  // Free text is never part of the automatic projection. Explicitly included
  // text still needs review: redaction cannot recognize every private phrase.
  const credentialNames =
    "access[-_]*token|refresh[-_]*token|id[-_]*token|client[-_]*secret|api[-_]*key|token|secret|password|passwd|authorization|proxy[-_]*authorization|cookie|set[-_]*cookie|private[-_]*key"
  const credentialKey = new RegExp("^(?:" + credentialNames + ")$", "i")
  const quotedValue = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[\[{][\s\S]*|[^\r\n]+/
  const credentialFields = new RegExp(
    "((?:\\\\)*[\"']?)(" + credentialNames + ")\\1\\s*[:=]\\s*(?:" + quotedValue.source + ")",
    "gi",
  )
  const environmentFields = new RegExp(
    "((?:\\\\)*[\"']?)([A-Z][A-Z0-9_]{2,})\\1\\s*[:=]\\s*(?:" + quotedValue.source + ")",
    "g",
  )

  // Parse before matching text so escaped quotes and nested credential values
  // cannot leave a suffix behind. Malformed/truncated JSON still uses redaction.
  export function redact(value: string): string {
    const text = value.slice(0, 32_000)
    try {
      return JSON.stringify(redactJSON(JSON.parse(text), 0), null, 2)
    } catch {
      return redactText(text)
    }
  }

  function redactJSON(value: unknown, depth: number): unknown {
    if (depth > 64) return "[nested-content-omitted]"
    if (typeof value === "string") return redactText(value)
    if (Array.isArray(value)) return value.map((item) => redactJSON(item, depth + 1))
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactText(key),
        credentialKey.test(key) || /^[A-Z][A-Z0-9_]{2,}$/.test(key) ? "[redacted]" : redactJSON(item, depth + 1),
      ]),
    )
  }

  function redactText(value: string) {
    return value
      .replace(/https?:(?:\\?\/){2}[^\s<>"')]+/gi, (value) => {
        const normalized = value.replace(/\\\//g, "/")
        if (!URL.canParse(normalized)) return "[url]"
        const url = new URL(normalized)
        return `${url.protocol}//${url.host}/[path-removed]`
      })
      .replace(/\b(?:Bearer|Basic)\s+[^\s,"';}\]]+/gi, "[credential]")
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g, "[credential]")
      .replace(/^([ \t]*)(cookie|set-cookie)\s*:[^\r\n]*/gim, "$1$2: [redacted]")
      .replace(credentialFields, maskField)
      .replace(environmentFields, maskField)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/(?:[A-Z]:[\\/]|\\\\)[^\r\n"<>|]*/gi, "[local-path]")
      .replace(/\/(?:Users|home|tmp|var|workspace|projects?)\/[^\s"<>]*/gi, "[local-path]")
  }

  function maskField(_value: string, quote: string, key: string) {
    const delimiter = quote.endsWith('"') || quote.endsWith("'") ? quote : '"'
    return `${quote}${key}${quote}: ${delimiter}[redacted]${delimiter}`
  }

  export function suggestion(error: string) {
    if (/\b401\b|invalid[_ -]?(?:api[_ -]?)?key|authentication/i.test(error)) return "auth"
    if (/\b402\b|insufficient[_ -]?(?:quota|credit)|balance/i.test(error)) return "credit"
    if (/\b429\b|rate[_ -]?limit/i.test(error)) return "rate"
    if (/proxy|ECONN|ETIMEDOUT|ENOTFOUND|network|fetch failed/i.test(error)) return "network"
    if (/model.*(?:not found|unavailable)|\b404\b/i.test(error)) return "model"
    return "unknown"
  }

  export function snapshot(input: {
    description: string
    context: Context
    now: number
    include: { environment: boolean; events: boolean; errors: boolean }
    details?: string
    conversation?: string
    code?: string
    modelNames?: { provider?: string; model?: string }
    image?: string
  }): Snapshot {
    const context = input.context
    const allowed = (value: string | undefined, values: string[]) => (values.includes(value ?? "") ? value : "unknown")
    const time = (at: number) => Number.isFinite(at) && at >= input.now - 300_000 && at <= input.now
    const report = {
      format: 1,
      reportID: crypto.randomUUID(),
      created: new Date(input.now).toISOString(),
      description: redact(input.description),
      ...(input.include.environment
        ? {
            environment: {
              version: /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/.test(context.version ?? "") ? context.version : "unknown",
              platform: allowed(context.platform, ["windows", "macos", "linux", "web"]),
              provider: context.provider
                ? allowed(context.provider, ["openai", "anthropic", "google", "deepseek", "custom"]) === "unknown"
                  ? "custom"
                  : context.provider
                : "unknown",
              model:
                /^(?:gpt|claude|gemini|deepseek)/i.exec(context.model ?? "")?.[0].toLowerCase() ?? "custom-or-unknown",
            },
          }
        : {}),
      ...(input.include.events
        ? {
            events: (context.events ?? [])
              .filter((item) => time(item.at))
              .slice(-50)
              .map((item) => ({
                secondsAgo: Math.round((input.now - item.at) / 1000),
                kind: allowed(item.kind, [
                  "read",
                  "write",
                  "bash",
                  "apply_patch",
                  "browser",
                  "task",
                  "message",
                  "main",
                  "renderer",
                  "server",
                  "network",
                ]),
                state: allowed(item.state, ["pending", "running", "completed", "error", "info", "warn"]),
              })),
          }
        : {}),
      ...(input.include.errors
        ? {
            errors: (context.errors ?? [])
              .filter((item) => time(item.at))
              .slice(-20)
              .map((item) => ({
                secondsAgo: Math.round((input.now - item.at) / 1000),
                status:
                  Number.isInteger(item.status) && item.status! >= 400 && item.status! <= 599 ? item.status : undefined,
                category: allowed(item.category, ["auth", "credit", "rate", "network", "model", "unknown"]),
              })),
          }
        : {}),
    }
    const text = JSON.stringify(report, null, 2)
    const files = [
      { name: "report.json", text },
      ...(["details", "conversation", "code"] as const).flatMap((key) =>
        input[key] === undefined ? [] : [{ name: `${key}.txt`, text: redact(input[key]) }],
      ),
      ...(input.modelNames
        ? [
            {
              name: "model.txt",
              text: JSON.stringify(
                {
                  provider: redact(input.modelNames.provider ?? "unknown"),
                  model: redact(input.modelNames.model ?? "unknown"),
                },
                null,
                2,
              ),
            },
          ]
        : []),
    ].map((file) => Object.freeze(file))
    const image =
      input.image && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.image) && input.image.length <= 4_000_000
        ? input.image
        : undefined
    return Object.freeze({ text, files: Object.freeze(files), ...(image ? { image } : {}) })
  }

  // Native IO accepts only the exact, bounded preview payload and fixed names.
  // It never accepts filesystem paths or reads additional logs during export.
  export function validSnapshot(value: unknown): value is Snapshot {
    if (!value || typeof value !== "object" || !("text" in value) || !("files" in value)) return false
    if (typeof value.text !== "string" || value.text.length > 64_000 || !Array.isArray(value.files)) return false
    if (value.files.length < 1 || value.files.length > 5) return false
    const names = new Set<string>()
    for (const file of value.files) {
      if (
        !file ||
        typeof file !== "object" ||
        !["report.json", "details.txt", "conversation.txt", "code.txt", "model.txt"].includes(file.name) ||
        typeof file.text !== "string" ||
        file.text.length > 64_000 ||
        names.has(file.name)
      )
        return false
      names.add(file.name)
    }
    if (value.files[0].name !== "report.json" || value.files[0].text !== value.text) return false
    return (
      !("image" in value) ||
      (typeof value.image === "string" &&
        value.image.length <= 4_000_000 &&
        /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.image))
    )
  }

  export function copy(snapshot: Snapshot) {
    return snapshot.files.map((file) => `--- ${file.name} ---\n${file.text}`).join("\n\n")
  }
}
