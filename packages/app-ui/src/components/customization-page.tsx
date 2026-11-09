import { For, Show, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Option, Schema } from "effect"
import type { ZaovraClient, CommandView } from "@zaovra-ai/sdk/v2/client"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { completeMcpOAuth } from "@/context/global-sync/mcp"
import { adaptCommand } from "@/context/global-sync/utils"

const labels = {
  zh: {
    title: "自定义",
    back: "返回",
    refresh: "刷新",
    loading: "正在加载…",
    failed: "操作未完成，请重试。",
    project: "当前项目",
    mcp: "MCP",
    skills: "技能",
    add: "添加MCP",
    name: "名称",
    kind: "连接方式",
    local: "本地程序",
    remote: "远程服务",
    program: "程序",
    args: "参数（每行一个）",
    url: "服务地址",
    advanced: "请求头或环境变量（可选）",
    headers: "请求头（JSON对象）",
    environment: "环境变量（JSON对象）",
    save: "添加",
    cancel: "取消",
    remove: "删除",
    confirmRemove: "确认删除",
    confirm: "删除这个MCP配置？",
    enabled: "已启用",
    disabled: "已关闭",
    connected: "已连接",
    needs_auth: "需要授权",
    error: "连接失败",
    authorize: "授权连接",
    retry: "重试连接",
    emptyMcp: "尚未添加MCP。添加本地程序或远程服务后即可使用。",
    emptySkills: "未发现技能。将SKILL.md放到项目的.zaovra/skills目录，然后刷新。",
    readOnly: "当前配置来自环境注入，需在配置来源处修改。",
    invalidJson: "高级配置必须是键和值均为文字的JSON对象。",
    noProject: "请选择项目后管理MCP和技能。",
    tools: "个工具",
    permission: "启用后仍受所选智能体的权限限制。",
  },
  en: {
    title: "Customize",
    back: "Back",
    refresh: "Refresh",
    loading: "Loading…",
    failed: "The action failed. Try again.",
    project: "Current project",
    mcp: "MCP",
    skills: "Skills",
    add: "Add MCP",
    name: "Name",
    kind: "Connection type",
    local: "Local program",
    remote: "Remote server",
    program: "Program",
    args: "Arguments (one per line)",
    url: "Server URL",
    advanced: "Headers or environment variables (optional)",
    headers: "Headers (JSON object)",
    environment: "Environment variables (JSON object)",
    save: "Add",
    cancel: "Cancel",
    remove: "Delete",
    confirmRemove: "Confirm delete",
    confirm: "Delete this MCP configuration?",
    enabled: "Enabled",
    disabled: "Disabled",
    connected: "Connected",
    needs_auth: "Authorization required",
    error: "Connection failed",
    authorize: "Authorize",
    retry: "Retry connection",
    emptyMcp: "No MCP servers yet. Add a local program or remote server to get started.",
    emptySkills: "No skills found. Add a SKILL.md under this project's .zaovra/skills directory, then refresh.",
    readOnly: "This configuration is supplied by the environment. Edit it at its source.",
    invalidJson: "Advanced configuration must be a JSON object with text keys and values.",
    noProject: "Select a project to manage MCP servers and skills.",
    tools: "tools",
    permission: "Enabled skills still follow the selected agent's permissions.",
  },
}

const stringMap = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))

export function CustomizationPage(props: {
  client: ZaovraClient
  directory: string
  onClose: () => void
  onCommands: (commands: CommandView[]) => void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const text = () => (language.locale().startsWith("zh") ? labels.zh : labels.en)
  const [state, setState] = createStore({
    tab: "mcp",
    adding: false,
    name: "",
    type: "remote" as "local" | "remote",
    url: "",
    program: "",
    args: "",
    advanced: "",
    pending: "",
    error: "",
    confirm: "",
    closed: false,
  })
  onCleanup(() => setState("closed", true))
  const location = () => ({ directory: props.directory })
  const [data, { refetch }] = createResource(
    () => props.directory || undefined,
    async () => {
      const info = await props.client.v2.customization.list({ location: location() }, { throwOnError: true })
      const commands = await props.client.v2.command.list({ location: location() }, { throwOnError: true })
      if (!state.closed) props.onCommands(commands.data.data.map(adaptCommand))
      return info.data.data
    },
  )
  const perform = async (id: string, action: () => Promise<unknown>) => {
    if (state.pending) return
    setState({ pending: id, error: "" })
    await Promise.resolve()
      .then(action)
      .then(() => refetch())
      .catch((error: unknown) => {
        if (!state.closed) setState("error", error instanceof Error ? error.message : text().failed)
      })
      .finally(() => {
        if (!state.closed) setState("pending", "")
      })
  }
  const add = () =>
    void perform("add", async () => {
      const decoded = state.advanced.trim() ? stringMap(state.advanced) : Option.none()
      if (state.advanced.trim() && Option.isNone(decoded)) throw new Error(text().invalidJson)
      const extras = Option.getOrUndefined(decoded)
      const config =
        state.type === "remote"
          ? { type: "remote" as const, url: state.url.trim(), ...(extras ? { headers: extras } : {}) }
          : {
              type: "local" as const,
              command: [state.program.trim(), ...state.args.split(/\r?\n/).filter((arg) => arg.length)],
              ...(extras ? { environment: extras } : {}),
            }
      await props.client.v2.customization.saveMcp(
        { name: state.name.trim(), config, location: location() },
        { throwOnError: true },
      )
      if (!state.closed) setState({ adding: false, name: "", url: "", program: "", args: "", advanced: "" })
    })
  const connect = (name: string) =>
    void perform(name, async () => {
      const current = await props.client.v2.mcp.status({ location: location() }, { throwOnError: true })
      const auth = current.data.data[name]
      if (auth?.status !== "needs_auth") {
        await props.client.v2.mcp.connect({ name, location: location() }, { throwOnError: true })
        return
      }
      await completeMcpOAuth({
        begin: () =>
          props.client.v2.integration.connect
            .oauth(
              { integrationID: auth.integrationID, methodID: auth.methodID, inputs: {}, location: location() },
              { throwOnError: true },
            )
            .then((response) => response.data.data),
        open: platform.openLink,
        status: (attemptID) =>
          props.client.v2.integration.attempt
            .status({ attemptID, location: location() }, { throwOnError: true })
            .then((response) => response.data.data),
        ready: () =>
          props.client.v2.integration
            .get({ integrationID: auth.integrationID, location: location() }, { throwOnError: true })
            .then((response) => (response.data.data?.connections.length ?? 0) > 0),
        connect: () =>
          props.client.v2.mcp.connect({ name, location: location() }, { throwOnError: true }).then(() => {}),
      })
    })
  const unavailable = () => !!state.pending || data.loading
  return (
    <section
      data-component="customization-page"
      class="flex size-full min-h-0 min-w-0 flex-col bg-v2-background-bg-base text-v2-text-text-base"
    >
      <header class="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-v2-border-border-muted px-6 py-3">
        <h1
          tabIndex={-1}
          ref={(element) =>
            queueMicrotask(() => {
              if (element.isConnected) element.focus({ preventScroll: true })
            })
          }
          class="text-base font-medium outline-none"
        >
          {text().title}
        </h1>
        <ButtonV2 variant="ghost-muted" onClick={props.onClose}>
          {text().back}
        </ButtonV2>
      </header>
      <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
        <p class="break-all text-sm text-v2-text-text-muted">
          {text().project}: {props.directory || text().noProject}
        </p>
        <Show when={props.directory}>
          <nav class="flex items-center gap-2" aria-label={text().title}>
            <ButtonV2
              variant={state.tab === "mcp" ? "neutral" : "ghost-muted"}
              aria-pressed={state.tab === "mcp"}
              onClick={() => setState("tab", "mcp")}
            >
              {text().mcp}
            </ButtonV2>
            <ButtonV2
              variant={state.tab === "skills" ? "neutral" : "ghost-muted"}
              aria-pressed={state.tab === "skills"}
              onClick={() => setState("tab", "skills")}
            >
              {text().skills}
            </ButtonV2>
            <ButtonV2
              class="ml-auto"
              variant="ghost-muted"
              disabled={unavailable()}
              onClick={() => void perform("refresh", async () => {})}
            >
              {text().refresh}
            </ButtonV2>
          </nav>
          <Show when={data.loading}>
            <p role="status">{text().loading}</p>
          </Show>
          <Show when={data.error || state.error}>
            <p role="alert" class="select-text break-words">
              {state.error || text().failed}
            </p>
          </Show>
          <Show when={!data.error && data()}>
            {(info) => (
              <>
                <Show when={state.tab === "mcp"}>
                  <div class="flex flex-col gap-3">
                    <Show when={!info().mcpEditable}>
                      <p>{text().readOnly}</p>
                    </Show>
                    <Show when={!state.adding}>
                      <ButtonV2
                        class="self-start"
                        disabled={unavailable() || !info().mcpEditable}
                        onClick={() => setState("adding", true)}
                      >
                        {text().add}
                      </ButtonV2>
                    </Show>
                    <Show when={state.adding}>
                      <form
                        class="flex max-w-xl flex-col gap-3 rounded-lg border border-v2-border-border-muted p-4"
                        onSubmit={(event) => {
                          event.preventDefault()
                          add()
                        }}
                      >
                        <label class="flex flex-col gap-1 text-sm">
                          {text().name}
                          <input
                            name="mcp-name"
                            required
                            maxLength={128}
                            disabled={unavailable()}
                            value={state.name}
                            onInput={(event) => setState("name", event.currentTarget.value)}
                            class="rounded-md border border-v2-border-border-muted bg-transparent px-3 py-2"
                          />
                        </label>
                        <label class="flex flex-col gap-1 text-sm">
                          {text().kind}
                          <select
                            name="mcp-type"
                            disabled={unavailable()}
                            value={state.type}
                            onChange={(event) =>
                              setState({
                                type: event.currentTarget.value === "local" ? "local" : "remote",
                                advanced: "",
                              })
                            }
                            class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-3 py-2"
                          >
                            <option value="remote">{text().remote}</option>
                            <option value="local">{text().local}</option>
                          </select>
                        </label>
                        <Show
                          when={state.type === "remote"}
                          fallback={
                            <>
                              <label class="flex flex-col gap-1 text-sm">
                                {text().program}
                                <input
                                  name="mcp-program"
                                  required
                                  disabled={unavailable()}
                                  value={state.program}
                                  onInput={(event) => setState("program", event.currentTarget.value)}
                                  class="rounded-md border border-v2-border-border-muted bg-transparent px-3 py-2"
                                />
                              </label>
                              <label class="flex flex-col gap-1 text-sm">
                                {text().args}
                                <textarea
                                  name="mcp-args"
                                  rows={3}
                                  disabled={unavailable()}
                                  value={state.args}
                                  onInput={(event) => setState("args", event.currentTarget.value)}
                                  class="rounded-md border border-v2-border-border-muted bg-transparent px-3 py-2"
                                />
                              </label>
                            </>
                          }
                        >
                          <label class="flex flex-col gap-1 text-sm">
                            {text().url}
                            <input
                              name="mcp-url"
                              type="url"
                              required
                              disabled={unavailable()}
                              value={state.url}
                              onInput={(event) => setState("url", event.currentTarget.value)}
                              class="rounded-md border border-v2-border-border-muted bg-transparent px-3 py-2"
                            />
                          </label>
                        </Show>
                        <details>
                          <summary class="cursor-pointer text-sm text-v2-text-text-muted">{text().advanced}</summary>
                          <label class="mt-2 flex flex-col gap-1 text-sm">
                            {state.type === "local" ? text().environment : text().headers}
                            <textarea
                              name="mcp-advanced"
                              rows={3}
                              disabled={unavailable()}
                              value={state.advanced}
                              onInput={(event) => setState("advanced", event.currentTarget.value)}
                              class="rounded-md border border-v2-border-border-muted bg-transparent px-3 py-2 font-mono"
                            />
                          </label>
                        </details>
                        <div class="flex gap-2">
                          <ButtonV2 type="submit" disabled={unavailable() || !state.name.trim()}>
                            {text().save}
                          </ButtonV2>
                          <ButtonV2
                            variant="ghost-muted"
                            disabled={unavailable()}
                            onClick={() => setState("adding", false)}
                          >
                            {text().cancel}
                          </ButtonV2>
                        </div>
                      </form>
                    </Show>
                    <Show
                      when={info().mcp.length}
                      fallback={<p class="text-sm text-v2-text-text-muted">{text().emptyMcp}</p>}
                    >
                      <ul class="divide-y divide-v2-border-border-muted">
                        <For each={info().mcp}>
                          {(item) => (
                            <li data-mcp-name={item.name} class="flex flex-wrap items-center gap-3 py-4">
                              <div class="min-w-0 flex-1 basis-40">
                                <p class="truncate font-medium">{item.name}</p>
                                <p class="truncate text-sm text-v2-text-text-muted">
                                  {item.type === "remote" ? item.url : item.command?.join(" ")}
                                </p>
                                <p class="text-sm text-v2-text-text-muted">
                                  {item.disabled
                                    ? text().disabled
                                    : item.status === "failed"
                                      ? text().error
                                      : text()[item.status]}
                                  {item.tools !== undefined ? ` · ${item.tools} ${text().tools}` : ""}
                                </p>
                                <Show when={item.error}>
                                  <p class="select-text break-words text-sm">{item.error}</p>
                                </Show>
                              </div>
                              <label class="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  aria-label={`${item.name} ${text().enabled}`}
                                  checked={!item.disabled}
                                  disabled={unavailable() || !info().mcpEditable}
                                  onChange={(event) => {
                                    const enabled = event.currentTarget.checked
                                    void perform(item.name, () =>
                                      props.client.v2.customization.toggleMcp(
                                        { name: item.name, enabled, location: location() },
                                        { throwOnError: true },
                                      ),
                                    )
                                  }}
                                />
                                {text().enabled}
                              </label>
                              <Show when={!item.disabled && (item.status === "needs_auth" || item.status === "failed")}>
                                <ButtonV2
                                  variant="ghost-muted"
                                  disabled={unavailable()}
                                  onClick={() => connect(item.name)}
                                >
                                  {item.status === "needs_auth" ? text().authorize : text().retry}
                                </ButtonV2>
                              </Show>
                              <Show
                                when={state.confirm === item.name}
                                fallback={
                                  <ButtonV2
                                    variant="ghost-muted"
                                    disabled={unavailable() || !info().mcpEditable}
                                    onClick={() => setState("confirm", item.name)}
                                  >
                                    {text().remove}
                                  </ButtonV2>
                                }
                              >
                                <div class="flex flex-wrap items-center gap-2 text-sm">
                                  <span>{text().confirm}</span>
                                  <ButtonV2
                                    disabled={unavailable()}
                                    onClick={() =>
                                      void perform(item.name, async () => {
                                        await props.client.v2.customization.removeMcp(
                                          { name: item.name, location: location() },
                                          { throwOnError: true },
                                        )
                                        if (!state.closed) setState("confirm", "")
                                      })
                                    }
                                  >
                                    {text().confirmRemove}
                                  </ButtonV2>
                                  <ButtonV2
                                    variant="ghost-muted"
                                    disabled={unavailable()}
                                    onClick={() => setState("confirm", "")}
                                  >
                                    {text().cancel}
                                  </ButtonV2>
                                </div>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                </Show>
                <Show when={state.tab === "skills"}>
                  <p class="text-sm text-v2-text-text-muted">{text().permission}</p>
                  <Show when={!info().skillsEditable}>
                    <p>{text().readOnly}</p>
                  </Show>
                  <Show
                    when={info().skills.length}
                    fallback={<p class="text-sm text-v2-text-text-muted">{text().emptySkills}</p>}
                  >
                    <ul class="divide-y divide-v2-border-border-muted">
                      <For each={info().skills}>
                        {(skill) => (
                          <li data-skill-name={skill.name} class="flex items-start gap-4 py-4">
                            <div class="min-w-0 flex-1">
                              <p class="font-medium">{skill.name}</p>
                              <p class="text-sm text-v2-text-text-muted">{skill.description}</p>
                              <p class="select-text break-all text-xs text-v2-text-text-muted">{skill.location}</p>
                            </div>
                            <label class="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                aria-label={`${skill.name} ${text().enabled}`}
                                checked={!skill.disabled}
                                disabled={unavailable() || !info().skillsEditable}
                                onChange={(event) => {
                                  const enabled = event.currentTarget.checked
                                  void perform(skill.name, () =>
                                    props.client.v2.customization.toggleSkill(
                                      { name: skill.name, enabled, location: location() },
                                      { throwOnError: true },
                                    ),
                                  )
                                }}
                              />
                              {text().enabled}
                            </label>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </div>
    </section>
  )
}
