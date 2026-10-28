import { type ComponentProps, createMemo, Show, splitProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Card, CardDescription } from "@zaovra-ai/ui/card"
import { Collapsible } from "@zaovra-ai/ui/collapsible"
import { Icon } from "@zaovra-ai/ui/icon"
import { IconButton } from "@zaovra-ai/ui/icon-button"
import { Tooltip } from "@zaovra-ai/ui/tooltip"
import { useI18n } from "@zaovra-ai/ui/context/i18n"

export interface ToolErrorCardProps extends Omit<ComponentProps<typeof Card>, "children" | "variant"> {
  tool: string
  error: string
  title?: string
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  subtitle?: string
  href?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export function toolFailureMessage(input: {
  error: string
  tool?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const path =
    input.input?.path ??
    input.input?.filePath ??
    input.error.match(/(?:File not found:|Unable to read)\s+([^\r\n]+)/i)?.[1]
  const target = typeof path === "string" ? (path.split(/[\\/]/).at(-1) ?? path) : ""
  const reason = input.metadata?.readFailure
  const kind =
    reason === "not_found" || /\b(?:ENOENT|file not found|no such file|does not exist)\b/i.test(input.error)
      ? "missingAction"
      : reason === "permission" ||
          input.metadata?.phase === "permission" ||
          /\b(?:permission denied|access denied|EACCES|EPERM)\b/i.test(input.error)
        ? "permissionAction"
        : /\bOutcome may have occurred\b|\bpartial\b|\btimeout\b|\btimed out\b/i.test(input.error)
          ? "uncertainAction"
          : /\bVerification failed\b/i.test(input.error)
            ? "verificationAction"
            : input.tool === "bash"
              ? "commandAction"
              : input.tool === "read" || target
                ? "readAction"
                : "actionable"
  return { key: `ui.toolErrorCard.${kind}`, target, critical: input.metadata?.phase === "permission" }
}

export function ToolFailureNotice(props: {
  error: string
  tool?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const i18n = useI18n()
  const message = () => toolFailureMessage(props)
  return (
    <p
      data-component="tool-failure-notice"
      role="status"
      class="text-13-regular py-2"
      style={{ color: message().critical ? "var(--text-critical-base)" : "var(--icon-warning-active)" }}
    >
      {i18n.t(message().key, { target: message().target })}
    </p>
  )
}

export function ToolErrorCard(props: ToolErrorCardProps) {
  const i18n = useI18n()
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    copied: false,
  })
  const open = () => props.open ?? state.open
  const copied = () => state.copied
  const [split, rest] = splitProps(props, [
    "tool",
    "error",
    "title",
    "defaultOpen",
    "open",
    "onOpenChange",
    "subtitle",
    "href",
    "input",
    "metadata",
  ])
  const setOpen = (value: boolean) => {
    if (props.open === undefined) setState("open", value)
    props.onOpenChange?.(value)
  }
  const name = createMemo(() => {
    if (split.title) return split.title
    const map: Record<string, string> = {
      read: "ui.tool.read",
      list: "ui.tool.list",
      glob: "ui.tool.glob",
      grep: "ui.tool.grep",
      task: "ui.tool.task",
      webfetch: "ui.tool.webfetch",
      websearch: "ui.tool.websearch",
      bash: "ui.tool.shell",
      apply_patch: "ui.tool.patch",
      question: "ui.tool.questions",
    }
    const key = map[split.tool]
    if (!key) return split.tool
    if (!key.includes(".")) return key
    return i18n.t(key)
  })
  const cleaned = createMemo(() => split.error.replace(/^Error:\s*/, "").trim())
  const subtitle = createMemo(() => {
    if (split.subtitle) return split.subtitle
    const message = toolFailureMessage(props)
    return i18n.t(message.key, { target: message.target })
  })
  const body = createMemo(() => {
    return split.error
  })

  const copy = async () => {
    const text = cleaned()
    if (!text) return
    await navigator.clipboard.writeText(text)
    setState("copied", true)
    setTimeout(() => setState("copied", false), 2000)
  }

  return (
    <Card
      {...rest}
      data-kind="tool-error-card"
      data-open={open() ? "true" : "false"}
      variant={toolFailureMessage(props).critical ? "error" : "warning"}
    >
      <Collapsible class="tool-collapsible" data-open={open() ? "true" : "false"} open={open()} onOpenChange={setOpen}>
        <Collapsible.Trigger>
          <div data-component="tool-trigger">
            <div data-slot="basic-tool-tool-trigger-content">
              <span data-slot="basic-tool-tool-indicator" data-component="tool-error-card-icon">
                <Icon
                  name={toolFailureMessage(props).critical ? "circle-ban-sign" : "warning"}
                  size="small"
                  style={{ "stroke-width": 1.5 }}
                />
              </span>
              <div data-slot="basic-tool-tool-info">
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span data-slot="basic-tool-tool-title">{name()}</span>
                    <Show
                      when={split.href && split.subtitle}
                      fallback={<span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>}
                    >
                      <a
                        data-slot="basic-tool-tool-subtitle"
                        class="clickable subagent-link"
                        href={split.href!}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {subtitle()}
                      </a>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-slot="tool-error-card-content">
            <Show when={open()}>
              <div data-slot="tool-error-card-copy">
                <Tooltip
                  value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.toolErrorCard.copyError")}
                  placement="top"
                  gutter={4}
                >
                  <IconButton
                    icon={copied() ? "check" : "copy"}
                    size="normal"
                    variant="ghost"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation()
                      void copy()
                    }}
                    aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.toolErrorCard.copyError")}
                  />
                </Tooltip>
              </div>
            </Show>
            <Show when={body()}>{(value) => <CardDescription>{value()}</CardDescription>}</Show>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </Card>
  )
}
