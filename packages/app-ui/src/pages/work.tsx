import type { WorkAttemptInfo, WorkDetail } from "@zaovra-ai/sdk/v2/client"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { base64Encode } from "@zaovra-ai/core/util/encode"
import { useNavigate, useParams } from "@solidjs/router"
import { createMemo, createResource, For, onCleanup, onMount, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { workGoalControlDisabled, workGoalControls } from "./work-controls"
import { useLanguage } from "@/context/language"
import { workVerification } from "@/utils/verification-label"
import { useSettingsDialog } from "@/components/settings-dialog"

const defaultRole: WorkDetail["roles"][number]["id"] = "developer"

export default function WorkPage() {
  const language = useLanguage()
  const params = useParams<{ goalID?: string }>()
  const navigate = useNavigate()
  const serverSDK = useServerSDK()
  const [state, setState] = createStore({
    action: undefined as string | undefined,
    commands: [] as string[],
    error: undefined as string | undefined,
    draft: {
      open: false,
      objective: "",
      directory: "",
      directoryRevision: 0,
    },
    expansion: {
      open: false,
      title: "",
      instructions: "",
      dependsOn: "",
      role: defaultRole,
    },
    memoryEdit: {
      key: "",
      kind: "decision" as WorkDetail["memory"]["entries"][number]["candidates"][number]["item"]["kind"],
      text: "",
      reference: "",
    },
    memoryDelete: undefined as string | undefined,
  })
  const [goals, goalActions] = createResource(
    () => serverSDK().scope,
    () =>
      serverSDK()
        .client.v2.work.list()
        .then((result) => {
          if (!result.data) throw new Error("WorkGraph list returned no data")
          return result.data.data
        }),
  )
  const selected = createMemo(() => {
    if (!params.goalID) return undefined
    return { scope: serverSDK().scope, goalID: params.goalID }
  })
  const [detail, detailActions] = createResource(selected, (input) =>
    serverSDK()
      .client.v2.work.get({ goalID: input.goalID })
      .then((result) => {
        if (!result.data) throw new Error(`WorkGraph ${input.goalID} returned no data`)
        return result.data.data
      }),
  )

  const refresh = () => Promise.all([goalActions.refetch(), params.goalID ? detailActions.refetch() : undefined])
  const act = (name: string, request: () => Promise<unknown>) => {
    setState({ action: name, error: undefined })
    return request()
      .then(refresh)
      .catch((error: unknown) => setState("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setState("action", undefined))
  }
  const command = (name: string, request: () => Promise<unknown>) => {
    setState("commands", (commands) => [...commands, name])
    setState("error", undefined)
    return request()
      .then(refresh)
      .catch((error: unknown) => setState("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setState("commands", (commands) => commands.filter((command) => command !== name)))
  }
  const openCreate = () => {
    navigate("/work")
    setState("error", undefined)
    setState("draft", "open", true)
    if (state.draft.directory) return
    const revision = state.draft.directoryRevision
    const scope = serverSDK().scope
    void serverSDK()
      .client.path.get()
      .then((result) => {
        if (!state.draft.open || scope !== serverSDK().scope || revision !== state.draft.directoryRevision) return
        setState("draft", "directory", result.data?.directory ?? "")
      })
      .catch(() => undefined)
  }
  const createGoal = () => {
    const objective = state.draft.objective.trim()
    const directory = state.draft.directory.trim()
    if (!objective || !directory) return Promise.resolve()
    return act("create", () =>
      serverSDK()
        .client.v2.work.create({
          workCreateInput: {
            location: { directory },
            objective,
            acceptanceCriteria: [
              {
                description: `Verify that the objective is completely satisfied: ${objective}`,
                required: true,
                evidence: "review",
              },
            ],
            budget: {
              maxAttemptsPerTask: 8,
              maxRepairAttempts: 3,
              maxParallelTasks: 3,
              maxReplans: 2,
            },
            planning: true,
          },
        })
        .then((result) => {
          if (!result.data) throw new Error("WorkGraph creation returned no data")
          const goalID = result.data.data.goal.id
          setState("draft", { open: false, objective: "", directory })
          navigate(`/work/${goalID}`)
          return serverSDK().client.v2.work.resume({ goalID })
        }),
    )
  }
  const expandGoal = () => {
    const current = detail.latest
    const title = state.expansion.title.trim()
    const instructions = state.expansion.instructions.trim()
    if (!current || !title || !instructions) return Promise.resolve()
    return act("expand", () =>
      serverSDK()
        .client.v2.work.expand({
          goalID: current.goal.id,
          workExpandInput: {
            tasks: [
              {
                id: `task_${crypto.randomUUID().replaceAll("-", "")}`,
                title,
                instructions,
                dependsOn: state.expansion.dependsOn ? [state.expansion.dependsOn] : [],
                role: state.expansion.role,
                criteria: current.goal.acceptanceCriteria
                  .filter((criterion) => criterion.required)
                  .map((criterion) => criterion.id),
              },
            ],
          },
        })
        .then(() =>
          setState("expansion", { open: false, title: "", instructions: "", dependsOn: "", role: defaultRole }),
        ),
    )
  }
  onMount(() => {
    let scheduled: ReturnType<typeof setTimeout> | undefined
    const queueRefresh = () => {
      if (scheduled) return
      scheduled = setTimeout(() => {
        scheduled = undefined
        void refresh()
      }, 75)
    }
    const unsubscribe = serverSDK().event.listen((event) => {
      if (!event.details?.type.startsWith("work.")) return
      queueRefresh()
    })
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return
      void refresh()
    }, 30_000)
    onCleanup(() => {
      unsubscribe()
      clearInterval(timer)
      if (scheduled) clearTimeout(scheduled)
    })
  })

  return (
    <div class="flex h-full min-h-0 w-full bg-v2-background-bg-base text-v2-text-text-base">
      <aside class="flex w-[300px] shrink-0 flex-col border-r border-v2-border-border-muted bg-v2-background-bg-deep">
        <div class="flex min-h-20 shrink-0 items-center justify-between gap-2 border-b border-v2-border-border-muted px-4 py-2">
          <div class="min-w-0">
            <div class="text-[13px] font-semibold">{language.t("work.experimental")}</div>
            <div class="text-[11px] text-v2-text-text-muted">{language.t("work.ui.durable.goals")}</div>
          </div>
          <div class="flex items-center gap-1">
            <ButtonV2 size="small" variant="ghost-muted" onClick={openCreate}>
              {language.t("work.ui.new")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost-muted" disabled={goals.loading} onClick={() => void refresh()}>
              {language.t("work.ui.refresh")}
            </ButtonV2>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <Show when={!goals.loading} fallback={<Empty label={language.t("work.ui.loading.goals")} />}>
            <Show
              when={(goals.latest?.length ?? 0) > 0}
              fallback={<Empty label={language.t("work.ui.no.durable.goals.yet")} />}
            >
              <For each={goals.latest}>
                {(goal) => (
                  <button
                    type="button"
                    class="mb-1 flex w-full flex-col gap-2 rounded-md px-3 py-2.5 text-left hover:bg-v2-background-bg-layer-02 data-[selected]:bg-v2-background-bg-layer-03"
                    data-selected={params.goalID === goal.id ? "" : undefined}
                    onClick={() => navigate(`/work/${goal.id}`)}
                  >
                    <div class="line-clamp-2 text-[13px] font-medium leading-5">{goal.objective}</div>
                    <div class="flex items-center justify-between gap-2 text-[11px] text-v2-text-text-muted">
                      <Status value={goal.status} />
                      <span>
                        {language.t("work.attemptRepairCounts", {
                          attempts: goal.usage.attempts,
                          repairs: goal.usage.repairs,
                        })}
                      </span>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </Show>
          <Show when={goals.error}>
            <div class="m-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-300">
              {String(goals.error)}
            </div>
          </Show>
        </div>
      </aside>

      <main class="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Show
          when={params.goalID}
          fallback={
            <Show
              when={state.draft.open}
              fallback={
                <div class="flex h-full flex-col items-center justify-center gap-4 text-[13px] text-v2-text-text-muted">
                  <span>{language.t("work.ui.select.an.existing.goal.or.create.durable.work")}</span>
                  <ButtonV2 variant="contrast" onClick={openCreate}>
                    {language.t("work.ui.new.goal")}
                  </ButtonV2>
                </div>
              }
            >
              <CreateGoal
                objective={state.draft.objective}
                directory={state.draft.directory}
                busy={state.action === "create"}
                error={state.error}
                onObjective={(value) => setState("draft", "objective", value)}
                onDirectory={(value) =>
                  setState("draft", { directory: value, directoryRevision: state.draft.directoryRevision + 1 })
                }
                onCancel={() => setState("draft", "open", false)}
                onCreate={createGoal}
              />
            </Show>
          }
        >
          <Show
            when={detail.latest}
            fallback={
              <Empty
                label={
                  detail.loading ? language.t("work.ui.loading.workgraph") : language.t("work.ui.goal.unavailable")
                }
              />
            }
          >
            {(current) => (
              <div class="mx-auto flex w-full max-w-[1180px] flex-col gap-5 p-6">
                <GoalHeader
                  detail={current()}
                  busy={state.action}
                  commands={state.commands}
                  error={state.error}
                  onResume={() =>
                    command("resume", () => serverSDK().client.v2.work.resume({ goalID: current().goal.id }))
                  }
                  onPause={() =>
                    command("pause", () => serverSDK().client.v2.work.pause({ goalID: current().goal.id }))
                  }
                  onReplan={() =>
                    command("replan", () =>
                      serverSDK().client.v2.work.replan({
                        goalID: current().goal.id,
                        workReplanInput: {
                          taskID: `task_${crypto.randomUUID().replaceAll("-", "")}`,
                          reason: `Architect replan requested from the WorkGraph control plane while Goal was ${current().goal.status}`,
                        },
                      }),
                    )
                  }
                  onCancel={() =>
                    command("cancel", () =>
                      serverSDK().client.v2.work.cancel({
                        goalID: current().goal.id,
                        reason: "Cancelled from WorkGraph control plane",
                      }),
                    )
                  }
                />

                <section class="grid grid-cols-2 gap-3 lg:grid-cols-6">
                  <Metric
                    label={language.t("work.ui.tasks")}
                    value={`${completedTasks(current())}/${current().tasks.length}`}
                  />
                  <Metric label={language.t("work.ui.attempts")} value={String(current().goal.usage.attempts)} />
                  <Metric label={language.t("work.ui.repairs")} value={String(current().goal.usage.repairs)} />
                  <Metric
                    label={language.t("work.ui.replans")}
                    value={String(current().tasks.filter((task) => task.role === "work-architect").length)}
                  />
                  <Metric label={language.t("work.ui.evidence")} value={String(current().evidence.length)} />
                  <Metric label={language.t("work.ui.handoffs")} value={String(current().handoffs.length)} />
                </section>

                <Section
                  title={language.t("work.ui.agent.organization")}
                  subtitle={language.t(
                    "work.ui.role.contracts.snapshotted.for.this.goal.including.agent.authority.and.handoff.policy",
                  )}
                >
                  <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    <For each={current().roles}>
                      {(role) => (
                        <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
                          <div class="flex items-start justify-between gap-3">
                            <div>
                              <div class="text-[12px] font-semibold text-v2-text-text-strong">{role.title}</div>
                              <details>
                                <summary>{language.t("session.outcome.details")}</summary>
                                <div class="mt-1 font-mono text-[10px] text-v2-text-text-muted">{role.agentID}</div>
                              </details>
                            </div>
                            <Status
                              label={
                                role.workspaceAccess === "write"
                                  ? language.t("work.ui.can.edit")
                                  : language.t("work.ui.read.only")
                              }
                            />
                          </div>
                          <p class="mt-2 line-clamp-2 text-[11px] leading-5 text-v2-text-text-muted">{role.purpose}</p>
                          <div class="mt-2 text-[10px] text-v2-text-text-muted">
                            {role.capabilities.join(" · ")} · {role.allowedIsolation.join(" / ")}
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Section>

                <Section
                  title={language.t("work.ui.task.graph")}
                  subtitle={language.t("work.ui.planner.parallel.executor.verifier.reviewer.merge.repair")}
                >
                  <Show when={["active", "paused"].includes(current().goal.status)}>
                    <div class="mb-3 flex flex-col gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
                      <div class="flex items-center justify-between gap-3">
                        <div class="text-[11px] text-v2-text-text-muted">
                          {language.t("work.ui.extend.the.live.dag.without.restarting.completed.tasks")}
                        </div>
                        <ButtonV2
                          size="small"
                          variant="ghost-muted"
                          disabled={state.action === "expand"}
                          onClick={() => setState("expansion", "open", !state.expansion.open)}
                        >
                          {state.expansion.open ? language.t("work.ui.close") : language.t("work.ui.add.task")}
                        </ButtonV2>
                      </div>
                      <Show when={state.expansion.open}>
                        <form
                          class="grid gap-3 lg:grid-cols-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void expandGoal()
                          }}
                        >
                          <input
                            class="h-9 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 text-[12px] outline-none focus:border-v2-border-border-focus"
                            value={state.expansion.title}
                            placeholder={language.t("work.ui.follow.up.task.title")}
                            onInput={(event) => setState("expansion", "title", event.currentTarget.value)}
                          />
                          <select
                            class="h-9 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 text-[12px] outline-none focus:border-v2-border-border-focus"
                            value={state.expansion.role}
                            onInput={(event) => {
                              const role = current().roles.find((item) => item.id === event.currentTarget.value)
                              if (!role) return
                              setState("expansion", "role", role.id)
                            }}
                          >
                            <For each={current().roles}>
                              {(role) => (
                                <option value={role.id}>
                                  {role.title} ·{" "}
                                  {role.workspaceAccess === "write"
                                    ? language.t("work.ui.can.edit")
                                    : language.t("work.ui.read.only")}
                                </option>
                              )}
                            </For>
                          </select>
                          <select
                            class="h-9 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 text-[12px] outline-none focus:border-v2-border-border-focus"
                            value={state.expansion.dependsOn}
                            onInput={(event) => setState("expansion", "dependsOn", event.currentTarget.value)}
                          >
                            <option value="">{language.t("work.ui.no.dependency")}</option>
                            <For
                              each={current().tasks.filter(
                                (task) => task.role !== "work-planner" && task.role !== "work-architect",
                              )}
                            >
                              {(task) => (
                                <option value={task.id}>
                                  {language.t("work.ui.after")}
                                  {task.title}
                                </option>
                              )}
                            </For>
                          </select>
                          <textarea
                            class="min-h-20 resize-y rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 py-2 text-[12px] leading-5 outline-none focus:border-v2-border-border-focus lg:col-span-2"
                            value={state.expansion.instructions}
                            placeholder={language.t("work.ui.describe.the.additional.result.this.task.must.produce")}
                            onInput={(event) => setState("expansion", "instructions", event.currentTarget.value)}
                          />
                          <div class="flex justify-end lg:col-span-2">
                            <ButtonV2
                              type="submit"
                              size="small"
                              variant="contrast"
                              disabled={
                                state.action === "expand" ||
                                !state.expansion.title.trim() ||
                                !state.expansion.instructions.trim()
                              }
                            >
                              {state.action === "expand"
                                ? language.t("work.ui.adding")
                                : language.t("work.ui.add.to.dag")}
                            </ButtonV2>
                          </div>
                        </form>
                      </Show>
                    </div>
                  </Show>
                  <div class="grid gap-3 xl:grid-cols-2">
                    <For each={current().tasks}>{(task) => <TaskCard task={task} detail={current()} />}</For>
                  </div>
                </Section>

                <Section
                  title={language.t("work.ui.attempt.timeline")}
                  subtitle={language.t("work.ui.every.provider.run.has.a.durable.identity.and.fence")}
                >
                  <Show
                    when={current().attempts.length > 0}
                    fallback={<Empty label={language.t("work.ui.no.attempts.admitted")} compact />}
                  >
                    <div class="flex flex-col gap-2">
                      <For each={current().attempts.slice().reverse()}>
                        {(attempt) => (
                          <AttemptRow
                            attempt={attempt}
                            taskTitle={current().tasks.find((task) => task.id === attempt.taskID)?.title}
                            busy={state.action}
                            onOpen={() => {
                              if (!attempt.sessionID) return
                              const task = current().tasks.find((item) => item.id === attempt.taskID)
                              const directory = task?.location?.directory ?? current().goal.location.directory
                              navigate(`/${base64Encode(directory)}/session/${attempt.sessionID}`)
                            }}
                            onRetry={() =>
                              act(`retry:${attempt.id}`, () =>
                                serverSDK().client.v2.work.resolveUnknown({
                                  goalID: current().goal.id,
                                  attemptID: attempt.id,
                                  resolution: "retry",
                                  reason: "Explicit retry authorized from WorkGraph control plane",
                                }),
                              )
                            }
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                </Section>

                <Section
                  title={language.t("work.ui.project.memory")}
                  subtitle={language.t("work.ui.governed.facts.decisions.constraints.and.explicit.conflict.resolution")}
                >
                  <Show
                    when={current().memory.entries.length > 0}
                    fallback={<Empty label={language.t("work.ui.no.governed.project.memory")} compact />}
                  >
                    <div class="flex max-h-[560px] flex-col gap-3 overflow-y-auto">
                      <For each={current().memory.entries}>
                        {(entry) => (
                          <article class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
                            <div class="flex items-center justify-between gap-3">
                              <div class="truncate font-mono text-[11px] text-v2-text-text-strong">{entry.key}</div>
                              <div class="flex items-center gap-2">
                                <Status value={entry.status} />
                                <ButtonV2
                                  size="small"
                                  variant="ghost-muted"
                                  disabled={!!state.action}
                                  onClick={() => {
                                    const selected = entry.resolution
                                      ? entry.candidates.find(
                                          (candidate) =>
                                            candidate.handoffID === entry.resolution?.handoffID &&
                                            candidate.itemDigest === entry.resolution?.itemDigest,
                                        )
                                      : undefined
                                    const value =
                                      entry.resolution?.value ?? selected?.item ?? entry.candidates.at(-1)?.item
                                    if (!value) return
                                    setState("memoryEdit", {
                                      key: entry.key,
                                      kind: value.kind,
                                      text: value.text,
                                      reference: value.reference ?? "",
                                    })
                                  }}
                                >
                                  {language.t("work.ui.edit")}
                                </ButtonV2>
                                <ButtonV2
                                  size="small"
                                  variant={state.memoryDelete === entry.key ? "contrast" : "ghost-muted"}
                                  disabled={!!state.action}
                                  onClick={() => {
                                    if (state.memoryDelete !== entry.key) {
                                      setState("memoryDelete", entry.key)
                                      return
                                    }
                                    void act(`memory-delete:${entry.key}`, () =>
                                      serverSDK()
                                        .client.v2.work.deleteMemory({ goalID: current().goal.id, key: entry.key })
                                        .then((result) => {
                                          setState("memoryDelete", undefined)
                                          return result
                                        }),
                                    )
                                  }}
                                >
                                  {state.memoryDelete === entry.key ? "Confirm delete" : "Delete"}
                                </ButtonV2>
                              </div>
                            </div>
                            <Show when={entry.resolution}>
                              {(resolution) => (
                                <div class="mt-2 text-[10px] leading-4 text-v2-text-text-muted">
                                  {language.t("work.ui.resolved.by")}
                                  {resolution().resolver}
                                  <Show when={resolution().reason}> · {resolution().reason}</Show>
                                </div>
                              )}
                            </Show>
                            <Show when={entry.resolution?.action === "replace" && entry.resolution.value}>
                              <div class="mt-3 rounded border border-emerald-500/30 bg-emerald-500/5 p-3">
                                <div class="text-[9px] font-medium uppercase tracking-wide text-emerald-400">
                                  {language.t("work.ui.user.correction")}
                                  {entry.resolution?.value?.kind}
                                </div>
                                <p class="mt-2 whitespace-pre-wrap text-[11px] leading-5">
                                  {entry.resolution?.value?.text}
                                </p>
                                <Show when={entry.resolution?.value?.reference}>
                                  <details>
                                    <summary>{language.t("session.outcome.details")}</summary>
                                    <div class="mt-2 font-mono text-[9px] text-v2-text-text-muted">
                                      {entry.resolution?.value?.reference}
                                    </div>
                                  </details>
                                </Show>
                              </div>
                            </Show>
                            <Show when={state.memoryEdit.key === entry.key}>
                              <form
                                class="mt-3 grid gap-2 rounded border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  const text = state.memoryEdit.text.trim()
                                  if (!text) return
                                  void act(`memory-update:${entry.key}`, () =>
                                    serverSDK()
                                      .client.v2.work.updateMemory({
                                        goalID: current().goal.id,
                                        key: entry.key,
                                        workUpdateMemoryInput: {
                                          kind: state.memoryEdit.kind,
                                          text,
                                          reference: state.memoryEdit.reference.trim() || undefined,
                                          reason: "Corrected from the WorkGraph project-memory control plane",
                                        },
                                      })
                                      .then((result) => {
                                        setState("memoryEdit", "key", "")
                                        return result
                                      }),
                                  )
                                }}
                              >
                                <select
                                  class="h-9 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 text-[12px] outline-none focus:border-v2-border-border-focus"
                                  value={state.memoryEdit.kind}
                                  onInput={(event) =>
                                    setState(
                                      "memoryEdit",
                                      "kind",
                                      event.currentTarget.value as typeof state.memoryEdit.kind,
                                    )
                                  }
                                >
                                  <For
                                    each={
                                      [
                                        "fact",
                                        "decision",
                                        "constraint",
                                        "risk",
                                        "lesson",
                                        "result",
                                        "artifact",
                                      ] as const
                                    }
                                  >
                                    {(kind) => <option value={kind}>{kind}</option>}
                                  </For>
                                </select>
                                <textarea
                                  class="min-h-24 resize-y rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 py-2 text-[12px] leading-5 outline-none focus:border-v2-border-border-focus"
                                  value={state.memoryEdit.text}
                                  onInput={(event) => setState("memoryEdit", "text", event.currentTarget.value)}
                                />
                                <input
                                  class="h-9 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 font-mono text-[11px] outline-none focus:border-v2-border-border-focus"
                                  value={state.memoryEdit.reference}
                                  placeholder={language.t("work.ui.optional.source.reference")}
                                  onInput={(event) => setState("memoryEdit", "reference", event.currentTarget.value)}
                                />
                                <div class="flex justify-end gap-2">
                                  <ButtonV2
                                    type="button"
                                    size="small"
                                    variant="neutral"
                                    onClick={() => setState("memoryEdit", "key", "")}
                                  >
                                    {language.t("work.ui.cancel")}
                                  </ButtonV2>
                                  <ButtonV2
                                    type="submit"
                                    size="small"
                                    variant="contrast"
                                    disabled={!!state.action || !state.memoryEdit.text.trim()}
                                  >
                                    {language.t("work.ui.save.correction")}
                                  </ButtonV2>
                                </div>
                              </form>
                            </Show>
                            <div class="mt-3 grid gap-2 xl:grid-cols-2">
                              <For each={entry.candidates}>
                                {(candidate) => {
                                  const selected = () =>
                                    entry.resolution?.handoffID === candidate.handoffID &&
                                    entry.resolution.itemDigest === candidate.itemDigest
                                  return (
                                    <div
                                      class="rounded border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3"
                                      classList={{ "border-emerald-500/60": selected() }}
                                    >
                                      <div class="flex items-center justify-between gap-2">
                                        <Status value={candidate.item.kind} />
                                        <details>
                                          <summary>{language.t("session.outcome.details")}</summary>
                                          <span class="truncate font-mono text-[9px] text-v2-text-text-muted">
                                            {candidate.producer} · {candidate.taskID}
                                          </span>
                                        </details>
                                      </div>
                                      <p class="mt-2 whitespace-pre-wrap text-[11px] leading-5">
                                        {candidate.item.text}
                                      </p>
                                      <Show when={candidate.item.reference}>
                                        <details>
                                          <summary>{language.t("session.outcome.details")}</summary>
                                          <div class="mt-2 truncate font-mono text-[9px] text-v2-text-text-muted">
                                            {candidate.item.reference}
                                          </div>
                                        </details>
                                      </Show>
                                      <div class="mt-3 flex items-center justify-between gap-3">
                                        <details>
                                          <summary>{language.t("session.outcome.details")}</summary>
                                          <span class="truncate font-mono text-[9px] text-v2-text-text-muted">
                                            {candidate.evidenceIDs.length}
                                            {language.t("work.ui.evidence.sha256")}
                                            {candidate.itemDigest.slice(0, 10)}
                                          </span>
                                        </details>
                                        <Show when={entry.status !== "current"}>
                                          <ButtonV2
                                            size="small"
                                            variant={selected() ? "contrast" : "neutral"}
                                            disabled={!!state.action || selected()}
                                            onClick={() =>
                                              void act(`memory:${entry.key}`, () =>
                                                serverSDK().client.v2.work.resolveMemory({
                                                  goalID: current().goal.id,
                                                  workResolveMemoryInput: {
                                                    key: entry.key,
                                                    handoffID: candidate.handoffID,
                                                    itemDigest: candidate.itemDigest,
                                                    reason: "Selected from the WorkGraph project-memory control plane",
                                                  },
                                                }),
                                              )
                                            }
                                          >
                                            {selected() ? language.t("work.ui.selected") : language.t("work.ui.select")}
                                          </ButtonV2>
                                        </Show>
                                      </div>
                                    </div>
                                  )
                                }}
                              </For>
                            </div>
                          </article>
                        )}
                      </For>
                    </div>
                  </Show>
                </Section>

                <For each={current().tasks.filter((task) => task.status === "merging")}>
                  {(task) => <MergeApproval goalID={current().goal.id} taskID={task.id} refresh={refresh} />}
                </For>

                <Section
                  title={language.t("work.ui.agent.mailbox")}
                  subtitle={language.t("work.ui.verified.structured.handoffs.between.tasks.and.into.project.memory")}
                >
                  <Show
                    when={current().handoffs.length > 0}
                    fallback={<Empty label={language.t("work.ui.no.handoffs.recorded")} compact />}
                  >
                    <div class="grid max-h-[520px] gap-3 overflow-y-auto xl:grid-cols-2">
                      <For each={current().handoffs.slice().reverse()}>
                        {(handoff) => (
                          <article class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
                            <div class="mb-2 flex items-center justify-between gap-3">
                              <Status value={handoff.producer} />
                              <details>
                                <summary>{language.t("session.outcome.details")}</summary>
                                <span class="truncate font-mono text-[10px] text-v2-text-text-muted">
                                  {handoff.taskID}
                                </span>
                              </details>
                            </div>
                            <p class="whitespace-pre-wrap text-[12px] leading-5">{handoff.summary}</p>
                            <div class="mt-2 text-[10px] text-v2-text-text-muted">
                              {language.t("work.ui.routed.to")}{" "}
                              {handoff.recipients.length > 0
                                ? handoff.recipients
                                    .map(
                                      (taskID) => current().tasks.find((task) => task.id === taskID)?.title ?? taskID,
                                    )
                                    .join(", ")
                                : "no downstream Task"}
                            </div>
                            <div class="mt-3 flex flex-col gap-2">
                              <For each={handoff.items}>
                                {(item) => (
                                  <div class="rounded bg-v2-background-bg-layer-02 px-2.5 py-2 text-[11px] leading-5">
                                    <span class="mr-2 font-mono uppercase text-v2-text-text-muted">{item.kind}</span>
                                    <Show when={item.memory}>
                                      <span class="mr-2 rounded bg-v2-background-bg-layer-03 px-1.5 py-0.5 font-mono text-[9px] uppercase text-v2-text-text-muted">
                                        {item.memory}
                                      </span>
                                    </Show>
                                    {item.text}
                                    <Show when={item.key}>
                                      <div class="mt-1 truncate font-mono text-[10px] text-v2-text-text-muted">
                                        key:{item.key}
                                      </div>
                                    </Show>
                                    <Show when={item.reference}>
                                      <details>
                                        <summary>{language.t("session.outcome.details")}</summary>
                                        <div class="mt-1 truncate font-mono text-[10px] text-v2-text-text-muted">
                                          {item.reference}
                                        </div>
                                      </details>
                                    </Show>
                                  </div>
                                )}
                              </For>
                            </div>
                            <details>
                              <summary>{language.t("session.outcome.details")}</summary>
                              <div class="mt-3 truncate font-mono text-[9px] text-v2-text-text-muted">
                                sha256:{handoff.digest}
                              </div>
                            </details>
                          </article>
                        )}
                      </For>
                    </div>
                  </Show>
                </Section>

                <div class="grid gap-5 xl:grid-cols-2">
                  <Section
                    title={language.t("work.ui.evidence")}
                    subtitle={language.t("work.ui.tests.commands.diffs.artifacts.and.reviews")}
                  >
                    <Show
                      when={current().evidence.length > 0}
                      fallback={<Empty label={language.t("work.ui.no.evidence.recorded")} compact />}
                    >
                      <div class="flex max-h-[420px] flex-col gap-2 overflow-y-auto">
                        <For each={current().evidence.slice().reverse()}>
                          {(item) => (
                            <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
                              <div class="mb-2 flex items-center justify-between text-[11px] text-v2-text-text-muted">
                                <Show
                                  when={
                                    item.kind === "review" ||
                                    item.kind === "command" ||
                                    item.producer === "work-verifier/command" ||
                                    item.producer === "session-host/1"
                                  }
                                  fallback={<Status value={item.kind} />}
                                >
                                  <span>
                                    {language.t(
                                      `verification.${workVerification(item, current().evaluations.find((evaluation) => evaluation.evidenceIDs.includes(item.id))?.verdict)}`,
                                    )}{" "}
                                    · <Status value={item.kind} />
                                  </span>
                                </Show>
                              </div>
                              <details>
                                <summary>{language.t("session.outcome.details")}</summary>
                                <div>{item.producer}</div>
                                <pre class="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5">
                                  {JSON.stringify(item.payload, null, 2)}
                                </pre>
                              </details>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Section>

                  <Section
                    title={language.t("work.ui.evaluations")}
                    subtitle={language.t("work.ui.acceptance.criteria.and.quality.verdicts")}
                  >
                    <Show
                      when={current().evaluations.length > 0}
                      fallback={<Empty label={language.t("work.ui.no.evaluations.recorded")} compact />}
                    >
                      <div class="flex max-h-[420px] flex-col gap-2 overflow-y-auto">
                        <For each={current().evaluations.slice().reverse()}>
                          {(item) => (
                            <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
                              <div class="flex items-center justify-between gap-3">
                                <Status value={item.verdict} />
                                <span class="truncate text-[11px] text-v2-text-text-muted">{item.evaluator}</span>
                              </div>
                              <For each={item.findings}>
                                {(finding) => (
                                  <div class="mt-2 text-[12px] leading-5">
                                    <span class="mr-2 uppercase text-v2-text-text-muted">{finding.severity}</span>
                                    {finding.message}
                                  </div>
                                )}
                              </For>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Section>
                </div>
              </div>
            )}
          </Show>
        </Show>
      </main>
    </div>
  )
}

function CreateGoal(props: {
  objective: string
  directory: string
  busy: boolean
  error?: string
  onObjective: (value: string) => void
  onDirectory: (value: string) => void
  onCancel: () => void
  onCreate: () => Promise<unknown>
}) {
  const language = useLanguage()
  const valid = () => props.objective.trim().length > 0 && props.directory.trim().length > 0

  return (
    <div class="mx-auto flex min-h-full w-full max-w-[760px] items-center p-6">
      <form
        class="flex w-full flex-col gap-5 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-6"
        onSubmit={(event) => {
          event.preventDefault()
          if (!valid()) return
          void props.onCreate()
        }}
      >
        <div>
          <h1 class="text-[18px] font-semibold text-v2-text-text-strong">
            {language.t("work.ui.create.durable.goal")}
          </h1>
          <p class="mt-1 text-[12px] leading-5 text-v2-text-text-muted">
            {language.t(
              "work.ui.a.durable.planner.will.inspect.the.project.create.a.validated.task.dag.run.independent.tasks.with.bounded.parallelism.verify.evidence.review.quality.and.repair.failures.within.budget",
            )}
          </p>
        </div>
        <label class="flex flex-col gap-2 text-[12px] font-medium">
          {language.t("work.ui.objective")}
          <textarea
            class="min-h-36 resize-y rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 py-2 text-[13px] font-normal leading-5 outline-none focus:border-v2-border-border-focus"
            autofocus
            value={props.objective}
            placeholder={language.t("work.ui.describe.the.outcome.that.must.be.achieved")}
            onInput={(event) => props.onObjective(event.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-2 text-[12px] font-medium">
          {language.t("work.ui.workspace.directory")}
          <input
            class="h-9 rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 font-mono text-[12px] font-normal outline-none focus:border-v2-border-border-focus"
            value={props.directory}
            placeholder="C:\\path\\to\\project"
            onInput={(event) => props.onDirectory(event.currentTarget.value)}
          />
        </label>
        <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-3 text-[11px] leading-5 text-v2-text-text-muted">
          {language.t(
            "work.ui.default.guardrails.up.to.8.attempts.per.task.3.repair.passes.and.3.concurrent.isolated.tasks.the.reviewer.must.explicitly.pass.the.objective.before.completion",
          )}
        </div>
        <Show when={props.error}>
          <div class="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-300">
            {props.error}
          </div>
        </Show>
        <div class="flex justify-end gap-2">
          <ButtonV2 type="button" variant="neutral" disabled={props.busy} onClick={props.onCancel}>
            {language.t("work.ui.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={props.busy || !valid()}>
            {props.busy ? language.t("work.ui.starting") : language.t("work.ui.create.run")}
          </ButtonV2>
        </div>
      </form>
    </div>
  )
}

function GoalHeader(props: {
  detail: WorkDetail
  busy?: string
  commands: string[]
  error?: string
  onResume: () => Promise<unknown>
  onPause: () => Promise<unknown>
  onReplan: () => Promise<unknown>
  onCancel: () => Promise<unknown>
}) {
  const language = useLanguage()
  const controls = () => workGoalControls(props.detail.goal.status)
  const pending = (command: string) => props.commands.includes(command)
  const disabled = (command: string) => workGoalControlDisabled({ busy: props.busy, commands: props.commands, command })

  return (
    <header class="flex flex-col gap-4 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-5">
      <div class="flex items-start justify-between gap-5">
        <div class="min-w-0">
          <div class="mb-2 flex items-center gap-2">
            <Status value={props.detail.goal.status} />
          </div>
          <h1 class="text-[20px] font-semibold leading-7 text-v2-text-text-strong">{props.detail.goal.objective}</h1>
          <details class="mt-2 text-[11px] text-v2-text-text-muted">
            <summary>{language.t("session.outcome.details")}</summary>
            <div>{props.detail.goal.id}</div>
            {props.detail.goal.location.directory}
            {language.t("work.ui.revision")}
            {props.detail.goal.revision}
            {language.t("work.ui.updated")} {new Date(props.detail.goal.time.updated).toLocaleString()}
          </details>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={controls().resume}>
            <ButtonV2 variant="contrast" disabled={disabled("resume")} onClick={() => void props.onResume()}>
              {pending("resume") ? language.t("work.ui.resuming") : language.t("work.ui.resume")}
            </ButtonV2>
          </Show>
          <Show when={controls().pause}>
            <ButtonV2 variant="neutral" disabled={disabled("pause")} onClick={() => void props.onPause()}>
              {pending("pause") ? language.t("work.ui.pausing") : language.t("work.ui.pause")}
            </ButtonV2>
          </Show>
          <Show when={controls().replan}>
            <ButtonV2 variant="neutral" disabled={disabled("replan")} onClick={() => void props.onReplan()}>
              {pending("replan") ? language.t("work.ui.replanning") : language.t("work.ui.architect.replan")}
            </ButtonV2>
          </Show>
          <Show when={controls().cancel}>
            <ButtonV2 variant="danger" disabled={disabled("cancel")} onClick={() => void props.onCancel()}>
              {pending("cancel") ? language.t("work.ui.cancelling") : language.t("work.ui.cancel")}
            </ButtonV2>
          </Show>
        </div>
      </div>
      <Show when={props.error}>
        <div class="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-300">{props.error}</div>
      </Show>
    </header>
  )
}

function TaskCard(props: { task: WorkDetail["tasks"][number]; detail: WorkDetail }) {
  const language = useLanguage()
  const attempts = () => props.detail.attempts.filter((attempt) => attempt.taskID === props.task.id)
  const evaluations = () => props.detail.evaluations.filter((item) => item.taskID === props.task.id)
  const handoff = () => props.detail.handoffs.find((item) => item.taskID === props.task.id)
  const role = () => props.detail.roles.find((item) => item.id === props.task.role)

  return (
    <article class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-[13px] font-semibold text-v2-text-text-strong">{props.task.title}</h3>
          <div class="mt-1 text-[11px] text-v2-text-text-muted">
            <Status value={props.task.role} /> ·{" "}
            {role()?.workspaceAccess === "read_only" ? language.t("work.ui.read.only") : language.t("work.ui.can.edit")}{" "}
            ·{" "}
            {props.task.location?.directory !== undefined &&
            props.task.location.directory !== props.detail.goal.location.directory
              ? language.t("work.ui.isolated")
              : language.t("work.ui.shared")}{" "}
            ·{" "}
            {language.t("work.attemptEvaluationCounts", {
              attempts: attempts().length,
              evaluations: evaluations().length,
            })}
          </div>
          <Show when={props.task.isolationState?.reason}>
            <div class="mt-1 text-xs" role="status">
              {props.task.isolationState?.status === "blocked"
                ? language.t("work.ui.isolation.failed.task.blocked")
                : language.t("work.ui.not.isolated")}
              {props.task.isolationState?.reason}
            </div>
          </Show>
        </div>
        <Status value={props.task.status} />
      </div>
      <p class="mt-3 line-clamp-3 whitespace-pre-wrap text-[12px] leading-5 text-v2-text-text-base">
        {props.task.instructions}
      </p>
      <Show when={props.task.dependsOn.length > 0}>
        <div class="mt-3 font-mono text-[10px] text-v2-text-text-muted">
          {language.t("work.ui.depends.on")}
          {props.task.dependsOn.map((id) => props.detail.tasks.find((task) => task.id === id)?.title ?? id).join(", ")}
        </div>
      </Show>
      <Show when={handoff()}>
        {(item) => (
          <div class="mt-3 rounded bg-v2-background-bg-layer-02 px-2.5 py-2 text-[11px] leading-5 text-v2-text-text-muted">
            {language.t("work.ui.handoff")}
            {item().summary}
          </div>
        )}
      </Show>
    </article>
  )
}

function AttemptRow(props: {
  attempt: WorkAttemptInfo
  taskTitle?: string
  busy?: string
  onOpen: () => void
  onRetry: () => Promise<unknown>
}) {
  const language = useLanguage()
  const settings = useSettingsDialog("providers")
  const missingModel = () => /No model (?:is )?available/i.test(props.attempt.failure?.message ?? "")
  const serverSDK = useServerSDK()
  const [modelDetails, setModelDetails] = createStore({ open: false })
  const [model] = createResource(
    () =>
      modelDetails.open && props.attempt.sessionID
        ? { id: props.attempt.sessionID, status: props.attempt.status, scope: serverSDK().scope }
        : undefined,
    async (input) => {
      const response = await serverSDK().client.v2.session.messages({ sessionID: input.id, limit: 100, order: "desc" })
      if (!response.data) throw new Error("Session model record unavailable")
      return response.data.data.find((message) => message.type === "assistant")
    },
  )
  return (
    <div class="flex flex-wrap items-center gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 py-2.5">
      <div class="w-16 shrink-0 font-mono text-[11px] uppercase text-v2-text-text-muted">
        <Status value={props.attempt.kind} />
      </div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[12px]">{props.taskTitle ?? language.t("work.ui.attempts")}</div>
        <details class="text-[10px] text-v2-text-text-muted">
          <summary>{language.t("session.outcome.details")}</summary>
          {props.attempt.id}
          <Show when={props.attempt.fence}>
            {language.t("work.ui.fence")}
            {props.attempt.fence}
          </Show>
        </details>
        <div class="mt-1 text-[10px] text-v2-text-text-muted">
          {language.t("work.ui.run")}
          {props.attempt.number}
          <Show when={props.attempt.failure}>
            {" "}
            · {missingModel() ? language.t("work.model.missing") : props.attempt.failure?.message}
          </Show>
          <Show when={missingModel()}>
            <ButtonV2 size="small" variant="ghost-muted" onClick={settings}>
              {language.t("work.model.settings")}
            </ButtonV2>
          </Show>
        </div>
      </div>
      <Status value={props.attempt.status} />
      <Show when={props.attempt.sessionID}>
        <ButtonV2 size="small" variant="ghost-muted" onClick={() => setModelDetails("open", !modelDetails.open)}>
          {language.t("work.model.used")}
        </ButtonV2>
        <Show when={modelDetails.open}>
          <span class="text-[11px] text-v2-text-text-muted">
            {model.loading
              ? "…"
              : model.error
                ? language.t("work.model.unavailable")
                : model()?.type === "assistant"
                  ? `${model()!.model.providerID} / ${model()!.model.id}`
                  : language.t("work.model.unrecorded")}
          </span>
        </Show>
        <ButtonV2 size="small" variant="ghost-muted" onClick={props.onOpen}>
          {language.t("work.ui.open.session")}
        </ButtonV2>
      </Show>
      <Show when={props.attempt.status === "unknown"}>
        <ButtonV2 size="small" variant="neutral" disabled={!!props.busy} onClick={() => void props.onRetry()}>
          {language.t("work.ui.authorize.retry")}
        </ButtonV2>
      </Show>
    </div>
  )
}

function Section(props: ParentProps<{ title: string; subtitle: string }>) {
  return (
    <section class="rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02 p-4">
      <div class="mb-3">
        <h2 class="text-[13px] font-semibold text-v2-text-text-strong">{props.title}</h2>
        <p class="mt-0.5 text-[11px] text-v2-text-text-muted">{props.subtitle}</p>
      </div>
      {props.children}
    </section>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-4 py-3">
      <div class="text-[11px] text-v2-text-text-muted">{props.label}</div>
      <div class="mt-1 text-[18px] font-semibold text-v2-text-text-strong">{props.value}</div>
    </div>
  )
}

function Empty(props: { label: string; compact?: boolean }) {
  return (
    <div
      classList={{
        "flex items-center justify-center text-[12px] text-v2-text-text-muted": true,
        "h-40": !props.compact,
        "py-8": !!props.compact,
      }}
    >
      {props.label}
    </div>
  )
}

function Status(props: { value: string; label?: never } | { label: string; value?: never }) {
  const language = useLanguage()
  const label = () => {
    if (props.label !== undefined) return props.label
    const key = `work.status.${props.value}`
    const text = language.t(key as Parameters<typeof language.t>[0])
    return !text || text === key ? props.value : text
  }
  return (
    <span
      data-component="work-status"
      data-value={props.value}
      class="inline-flex shrink-0 items-center rounded-full border border-v2-border-border-muted bg-v2-background-bg-layer-03 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-v2-text-text-base"
    >
      {label()}
    </span>
  )
}

function completedTasks(detail: WorkDetail) {
  return detail.tasks.filter((task) => task.status === "completed" || task.status === "superseded").length
}

function MergeApproval(props: { goalID: string; taskID: string; refresh: () => Promise<unknown> }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const [state, setState] = createStore({ busy: false, error: "" })
  const [review, actions] = createResource(
    () => [sdk().scope, props.goalID, props.taskID] as const,
    async () => {
      const result = await sdk().client.v2.work.mergeReview({ goalID: props.goalID, taskID: props.taskID })
      if (!result.data) throw new Error(language.t("work.ui.cannot.read.pending.changes"))
      return result.data
    },
  )
  const decide = async (approved: boolean) => {
    const current = review.error ? undefined : review()
    if (!current || state.busy) return
    setState({ busy: true, error: "" })
    try {
      const result = await sdk().client.v2.work.mergeDecide({
        goalID: props.goalID,
        taskID: props.taskID,
        workMergeDecision: { token: current.token, approved },
      })
      if (result.error)
        throw new Error(language.t("work.ui.approval.expired.or.could.not.be.saved.refresh.changes.and.retry"))
      await actions.refetch()
      await props.refresh()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("busy", false)
    }
  }
  return (
    <Section
      title={language.t("work.ui.review.and.apply.changes")}
      subtitle={language.t(
        "work.ui.the.isolated.task.is.complete.and.awaits.your.approval.changes.will.not.be.committed.or.pushed.automatically",
      )}
    >
      <Show when={review.error}>
        <p role="alert">
          {language.t(
            "work.ui.cannot.read.the.merge.baseline.or.changes.check.the.workspace.and.git.status.then.refresh.no.changes.will.be.applied.without.reviewable.evidence",
          )}
          <br />
          {String(review.error)}
          <ButtonV2 disabled={state.busy || review.loading} onClick={() => void actions.refetch()}>
            {language.t("work.ui.refresh.changes")}
          </ButtonV2>
        </p>
      </Show>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
      <Show when={!review.error && review()}>
        {(current) => (
          <>
            <p class="text-xs">
              {language.t("work.ui.target.baseline")}
              {current().baseline.slice(0, 12)}
            </p>
            <Show when={current().reason}>
              <p role="alert">{current().reason}</p>
            </Show>
            <pre class="max-h-96 overflow-auto whitespace-pre text-xs p-3">
              {current().diff || language.t("work.ui.no.file.differences")}
            </pre>
            <div class="flex gap-2">
              <ButtonV2 disabled={state.busy || review.loading || !!current().reason} onClick={() => void decide(true)}>
                {language.t("work.ui.approve.and.apply")}
              </ButtonV2>
              <ButtonV2 disabled={state.busy || review.loading} onClick={() => void decide(false)}>
                {language.t("work.ui.not.now")}
              </ButtonV2>
              <ButtonV2 disabled={state.busy} onClick={() => void actions.refetch()}>
                {language.t("work.ui.refresh.changes")}
              </ButtonV2>
            </div>
          </>
        )}
      </Show>
    </Section>
  )
}
