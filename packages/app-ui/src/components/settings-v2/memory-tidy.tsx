import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { TextInputV2 } from "@zaovra-ai/ui/v2/text-input-v2"
import type { MemoryTidyRequest, MemoryTidyTask } from "@zaovra-ai/sdk/v2/client"
import { For, Show, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { ModelSelectorPopoverV2 } from "@/components/dialog-select-model"
import { useModels, type ModelKey } from "@/context/models"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { Identifier } from "@/utils/id"

/** Mounted per server/directory: a confirmation never follows a later settings target. */
export function MemoryTidyPanel(props: { directory: string; disabled: boolean }) {
  const language = useLanguage()
  const models = useModels()
  const client = useServerSDK()().client.v2.memory
  const location = { directory: props.directory }
  const [state, setState] = createStore({
    layer: "project" as "project" | "user",
    model: undefined as ModelKey | undefined,
    tokens: "200000",
    dailyTokens: "1000000",
    request: undefined as MemoryTidyRequest | undefined,
    sent: false,
    busy: false,
    error: false,
  })
  const available = createMemo(() =>
    models.list().filter((item) => models.type({ providerID: item.provider.id, modelID: item.id }) === "chat"),
  )
  const selected = createMemo(() =>
    available().find((item) => item.id === state.model?.modelID && item.provider.id === state.model?.providerID),
  )
  const selection = {
    list: available,
    visible: models.visible,
    current: selected,
    set: (value: ModelKey | undefined) => {
      if (!state.request) setState("model", value)
    },
  }
  const [tasks, actions] = createResource(
    () => state.layer,
    async (layer) => (await client.listTidy({ location, layer }, { throwOnError: true })).data.data,
  )
  // Viewing/reopening never starts a task. Poll only while a task is actually running.
  createEffect(() => {
    if (!tasks()?.some((task) => task.executing)) return
    const timer = setInterval(() => {
      if (!tasks.loading) void Promise.resolve(actions.refetch()).catch(() => undefined)
    }, 2000)
    onCleanup(() => clearInterval(timer))
  })
  const valid = () =>
    selected() &&
    [state.tokens, state.dailyTokens].every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0) &&
    Number(state.tokens) <= Number(state.dailyTokens)
  const confirmation = () => ({
    requestID: Identifier.ascending("message"),
    layer: state.layer,
    model: { id: state.model!.modelID, providerID: state.model!.providerID },
    tokens: Number(state.tokens),
    dailyTokens: Number(state.dailyTokens),
  })
  const submit = async () => {
    if (state.busy || !state.request || props.disabled) return
    const request = state.request
    setState({ busy: true, error: false, sent: true })
    await client
      .prepareTidy({ location, memoryTidyRequest: request }, { throwOnError: true })
      .then((result) =>
        client.startTidy({ location, layer: request.layer, id: result.data.data.id }, { throwOnError: true }),
      )
      .then(
        () => setState({ request: undefined, sent: false }),
        () => setState("error", true),
      )
    await Promise.resolve(actions.refetch()).catch(() => setState("error", true))
    setState("busy", false)
  }
  const act = async (task: MemoryTidyTask, action: "start" | "cancel") => {
    if (state.busy || (action === "start" && props.disabled)) return
    setState({ busy: true, error: false })
    const input = { location, layer: task.layer, id: task.id }
    await (
      action === "start"
        ? client.startTidy(input, { throwOnError: true })
        : client.cancelTidy(input, { throwOnError: true })
    ).then(
      () => {
        if (state.request?.requestID === task.requestID) setState({ request: undefined, sent: false })
      },
      () => setState("error", true),
    )
    await Promise.resolve(actions.refetch()).catch(() => setState("error", true))
    setState("busy", false)
  }
  return (
    <section data-slot="memory-tidy" class="flex flex-col gap-3 rounded-lg border border-v2-border-base p-4">
      <h3 class="text-sm font-medium">{language.t("settings.memory.task.title")}</h3>
      <p class="text-xs text-v2-text-text-muted">{language.t("settings.memory.task.description")}</p>
      <p class="break-all text-xs">{props.directory}</p>
      <fieldset disabled={state.busy || !!state.request || props.disabled} class="flex flex-wrap items-center gap-3">
        <label class="text-xs">
          {language.t("settings.memory.task.scope")}
          <select
            value={state.layer}
            onChange={(event) => setState("layer", event.currentTarget.value === "user" ? "user" : "project")}
          >
            <option value="project">{language.t("settings.memory.project.title")}</option>
            <option value="user">{language.t("settings.memory.user.title")}</option>
          </select>
        </label>
        <ModelSelectorPopoverV2
          configuredOnly
          model={selection}
          triggerAs={ButtonV2}
          triggerProps={{
            variant: "neutral",
            disabled: state.busy || !!state.request || props.disabled,
            "aria-label": language.t("settings.memory.tidy.model"),
          }}
        >
          {selected()?.name ?? language.t("settings.memory.task.chooseModel")}
        </ModelSelectorPopoverV2>
        <label class="text-xs">
          {language.t("settings.memory.task.tokens")}
          <TextInputV2
            type="number"
            min="1"
            step="1"
            value={state.tokens}
            onInput={(event) => setState("tokens", event.currentTarget.value)}
          />
        </label>
        <label class="text-xs">
          {language.t("settings.memory.task.dailyTokens")}
          <TextInputV2
            type="number"
            min="1"
            step="1"
            value={state.dailyTokens}
            onInput={(event) => setState("dailyTokens", event.currentTarget.value)}
          />
        </label>
      </fieldset>
      <Show
        when={!state.request}
        fallback={
          <div data-slot="memory-tidy-confirm" class="flex flex-col gap-2">
            <p class="text-xs">{language.t("settings.memory.task.confirm")}</p>
            <p class="break-all text-xs">
              {state.request?.model.providerID} / {state.request?.model.id} ·{" "}
              {language.t(
                state.request?.layer === "user" ? "settings.memory.user.title" : "settings.memory.project.title",
              )}{" "}
              · {state.request?.tokens} / {state.request?.dailyTokens} tokens
            </p>
            <div class="flex gap-2">
              <ButtonV2 variant="neutral" disabled={state.busy || props.disabled} onClick={() => void submit()}>
                {language.t(state.sent ? "settings.memory.task.retry" : "settings.memory.task.start")}
              </ButtonV2>
              <Show when={!state.sent}>
                <ButtonV2 variant="neutral" onClick={() => setState("request", undefined)}>
                  {language.t("common.cancel")}
                </ButtonV2>
              </Show>
            </div>
          </div>
        }
      >
        <ButtonV2
          variant="neutral"
          disabled={
            props.disabled ||
            state.busy ||
            !valid() ||
            tasks.loading ||
            !!tasks.error ||
            !!tasks()?.some((task) => task.state === "active")
          }
          onClick={() => setState("request", confirmation())}
        >
          {language.t("settings.memory.task.review")}
        </ButtonV2>
      </Show>
      <Show when={state.error || tasks.error}>
        <p role="alert" class="text-xs">
          {language.t("settings.memory.task.failed")}
        </p>
      </Show>
      <ButtonV2
        variant="neutral"
        disabled={state.busy || tasks.loading}
        onClick={() => void Promise.resolve(actions.refetch()).catch(() => setState("error", true))}
      >
        {language.t("settings.memory.task.refresh")}
      </ButtonV2>
      <For each={tasks.loading ? [] : tasks()}>
        {(task) => (
          <div data-slot="memory-tidy-task" class="flex flex-col gap-2 border-t border-v2-border-base pt-3">
            <p class="text-sm">
              {language.t(
                task.state === "active"
                  ? task.executing
                    ? "settings.memory.task.running"
                    : "settings.memory.task.paused"
                  : task.state === "completed"
                    ? "settings.memory.task.completed"
                    : task.state === "cancelled"
                      ? "settings.memory.task.cancelled"
                      : "settings.memory.task.stopped",
              )}
            </p>
            <p class="break-all text-xs">
              {task.model.providerID} / {task.model.id} · {new Date(task.time.created).toLocaleString()}
            </p>
            <p class="text-xs">
              {language.t("settings.memory.task.charged")}: {task.usage.charged} / {task.tokens} ·{" "}
              {language.t("settings.memory.task.dailyTokens")}: {task.dailyTokens}
            </p>
            <Show when={task.usage.unknown > 0}>
              <p class="text-xs">
                {language.t("settings.memory.task.unknown")}: {task.usage.reserved} tokens ({task.usage.unknown})
              </p>
            </Show>
            <Show when={task.state === "active"}>
              <div class="flex gap-2">
                <Show when={!task.executing}>
                  <ButtonV2
                    variant="neutral"
                    disabled={state.busy || props.disabled || task.directory !== props.directory}
                    onClick={() => void act(task, "start")}
                  >
                    {language.t("settings.memory.task.continue")}
                  </ButtonV2>
                </Show>
                <ButtonV2 variant="neutral" disabled={state.busy} onClick={() => void act(task, "cancel")}>
                  {language.t("settings.memory.task.stop")}
                </ButtonV2>
              </div>
            </Show>
          </div>
        )}
      </For>
    </section>
  )
}
