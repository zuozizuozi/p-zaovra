import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"

export function ReasoningControl(props: {
  model: {
    current: () =>
      | { reasoningModels?: Record<string, string>; reasoningDefault?: boolean; capabilities: { reasoning: boolean } }
      | undefined
    variant: { list(): string[]; current(): string | undefined; set(value: string | undefined): void }
  }
}) {
  const language = useLanguage()
  const supported = () =>
    props.model.variant
      .list()
      .filter(
        (level) =>
          props.model.current()?.reasoningModels ||
          props.model.current()?.capabilities.reasoning ||
          ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level),
      )
  const levels = createMemo(() => {
    const standard = [
      ...(props.model.current()?.reasoningDefault === false ? [] : ["default"]),
      "low",
      "medium",
      "high",
      "max",
    ]
    const order = ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]
    return [...new Set([...standard, ...supported()])].sort((a, b) => {
      const left = order.indexOf(a)
      const right = order.indexOf(b)
      return (left < 0 ? order.length : left) - (right < 0 ? order.length : right)
    })
  })
  const enabled = (level: string) => level === "default" || supported().includes(level)
  const label = (level: string) => {
    const keys = {
      default: "common.default",
      low: "model.reasoning.low",
      medium: "model.reasoning.medium",
      high: "model.reasoning.high",
      xhigh: "model.reasoning.max",
      max: "model.reasoning.max",
    } as const
    return level in keys ? language.t(keys[level as keyof typeof keys]) : level
  }
  const current = () => props.model.variant.current() ?? "default"
  const select = (level: string) => {
    if (enabled(level)) props.model.variant.set(level === "default" ? undefined : level)
  }
  return (
    <Show when={supported().length > 0}>
      <div data-component="reasoning-control" class="flex w-40 shrink-0 flex-col gap-0.5 px-2 text-xs text-text-base">
        <label class="flex items-center justify-between gap-2">
          <span>{language.t("model.reasoning")}</span>
          <span class="capitalize">{label(current())}</span>
        </label>
        <input
          type="range"
          min="0"
          max={levels().length - 1}
          step="1"
          value={Math.max(0, levels().indexOf(current()))}
          aria-label={language.t("model.reasoning")}
          aria-valuetext={label(current())}
          class="h-3 w-full cursor-pointer accent-current"
          onInput={(event) => {
            const index = Number(event.currentTarget.value)
            const level = levels()
              .filter(enabled)
              .toSorted((a, b) => Math.abs(levels().indexOf(a) - index) - Math.abs(levels().indexOf(b) - index))[0]
            if (level) select(level)
            event.currentTarget.value = String(Math.max(0, levels().indexOf(current())))
          }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
            event.preventDefault()
            const items = levels().filter(enabled)
            const index = Math.max(0, items.indexOf(current()))
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : index + (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1)
            select(items[Math.max(0, Math.min(items.length - 1, next))])
          }}
        />
        <div class="flex justify-between gap-1">
          <For each={levels()}>
            {(level) => (
              <button
                type="button"
                class="text-[10px] capitalize disabled:cursor-not-allowed disabled:opacity-25"
                disabled={!enabled(level)}
                aria-pressed={current() === level}
                title={label(level)}
                data-supported={enabled(level)}
                onClick={() => select(level)}
              >
                {label(level)}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
