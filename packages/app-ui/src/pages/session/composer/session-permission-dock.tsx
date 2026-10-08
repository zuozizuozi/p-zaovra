import { createResource, For, Show } from "solid-js"
import type { PermissionView } from "@zaovra-ai/sdk/v2"
import { Button } from "@zaovra-ai/ui/button"
import { DockPrompt } from "@zaovra-ai/session-ui/dock-prompt"
import { Icon } from "@zaovra-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

export function SessionPermissionDock(props: {
  request: PermissionView
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const part = () => {
    const source = props.request.tool
    return (
      source &&
      sync().data.part[source.messageID]?.find((part) => part.type === "tool" && part.callID === source.callID)
    )
  }
  // Approval can arrive before the running tool is projected into the timeline.
  const [source] = createResource(
    () => props.request.permission === "bash" && !part() && props.request.tool,
    async (tool) => {
      const response = await sdk()
        .client.v2.session.message(
          { sessionID: props.request.sessionID, messageID: tool.messageID },
          { throwOnError: true },
        )
        .catch(() => undefined)
      const message = response?.data?.data
      return message?.type === "assistant"
        ? message.content.find((item) => item.type === "tool" && item.id === tool.callID)
        : undefined
    },
  )
  const directory = () => {
    const tool = part() ?? source.latest
    if (tool?.type !== "tool") return undefined
    if (typeof tool.state.input !== "object" || !tool.state.input) return undefined
    const workdir = tool.state.input.workdir
    return typeof workdir === "string" ? workdir : sdk().directory
  }

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }
  const patterns = () => [...new Set(props.request.patterns)]
  const remembered = () => [...new Set(props.request.always)].filter((pattern) => !patterns().includes(pattern))

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Show when={props.request.always.length > 0}>
              <Button
                variant="secondary"
                size="normal"
                onClick={() => props.onDecide("always")}
                disabled={props.responding}
              >
                {language.t("ui.permission.allowAlways")}
              </Button>
            </Show>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <code class="text-12-regular text-text-strong break-all">{props.request.permission}</code>
      </div>
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>
      <Show when={props.request.permission === "bash"}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">
            <p>{language.t("session.permission.bashAuthority")}</p>
            <p>
              {language.t("session.permission.directory")}: {directory() ?? language.t("usage.unknown")}
            </p>
            <p>{language.t("session.permission.decisions")}</p>
          </div>
        </div>
      </Show>
      <Show when={props.request.always.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <details class="min-w-0 text-12-regular text-text-base">
            <summary class="cursor-pointer">{language.t("session.permission.rememberScope")}</summary>
            <p class="py-1 text-text-weak">{language.t("session.permission.rememberHint")}</p>
            <For each={remembered()}>{(pattern) => <code class="block break-all">{pattern}</code>}</For>
          </details>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={patterns()}>
              {(pattern) => (
                <div>
                  <code class="text-12-regular text-text-base break-all">{pattern}</code>
                  <Show when={props.request.always.includes(pattern)}>
                    <p class="text-12-regular text-text-weak">{language.t("session.permission.sameScope")}</p>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
