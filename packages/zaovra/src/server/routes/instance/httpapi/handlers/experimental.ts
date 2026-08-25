import { Account } from "@/account/account"
import { DeviceCode, Login, UserCode } from "@/account/schema"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Project } from "@/project/project"
import { Worktree } from "@/worktree"
import { Duration, Effect, Option, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConsoleLoginPollPayload, ConsoleSwitchPayload, WorktreeApiError } from "../groups/experimental"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const config = yield* Config.Service
    const project = yield* Project.Service
    const worktreeSvc = yield* Worktree.Service
    const flags = yield* RuntimeFlags.Service

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const loginConsole = Effect.fn("ExperimentalHttpApi.consoleLogin")(function* () {
      const login = yield* account
        .login("https://zaovra.com")
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))))
      return {
        deviceCode: login.code,
        userCode: login.user,
        verificationUrl: login.url,
        server: login.server,
        expiresInMs: Duration.toMillis(login.expiry),
        intervalMs: Duration.toMillis(login.interval),
      }
    })

    const pollConsoleLogin = Effect.fn("ExperimentalHttpApi.consoleLoginPoll")(function* (ctx: {
      payload: typeof ConsoleLoginPollPayload.Type
    }) {
      const result = yield* account
        .poll(
          new Login({
            code: Schema.decodeSync(DeviceCode)(ctx.payload.deviceCode),
            user: Schema.decodeSync(UserCode)(ctx.payload.userCode),
            url: ctx.payload.verificationUrl,
            server: ctx.payload.server,
            expiry: Duration.millis(ctx.payload.expiresInMs),
            interval: Duration.millis(ctx.payload.intervalMs),
          }),
        )
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))))

      if (result._tag === "PollSuccess") {
        yield* config.refresh()
        return { status: "success" as const, email: result.email }
      }
      if (result._tag === "PollPending") return { status: "pending" as const }
      if (result._tag === "PollSlow") return { status: "slow" as const }
      if (result._tag === "PollExpired") return { status: "expired" as const }
      if (result._tag === "PollDenied") return { status: "denied" as const }
      return { status: "error" as const }
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("consoleLogin", loginConsole)
      .handle("consoleLoginPoll", pollConsoleLogin)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
  }),
)
