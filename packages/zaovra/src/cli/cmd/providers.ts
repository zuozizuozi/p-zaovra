import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { ModelsDev } from "@zaovra-ai/core/models-dev"

import { map, pipe, sortBy } from "remeda"
import { Effect, Option } from "effect"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Catalog } from "@zaovra-ai/core/catalog"
import { Integration } from "@zaovra-ai/core/integration"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { Location } from "@zaovra-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@zaovra-ai/core/location-services"
import { InstanceRef } from "@/effect/instance-ref"

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

const currentLocation = Effect.gen(function* () {
  const instance = yield* InstanceRef
  return Location.Ref.make({ directory: AbsolutePath.make(instance?.directory ?? process.cwd()) })
})

const withLocationServices = <Args, Value, Error, Requirements>(
  handler: (args: Args) => Effect.Effect<Value, Error, Requirements | LocationServiceMap.Service>,
) => (args: Args) => handler(args).pipe(Effect.provide(locationServiceMapLayer))

type ConnectMethod = Extract<Integration.Method, { type: "key" | "oauth" }>

const promptInputs = Effect.fn("Cli.providers.promptInputs")(function* (method: ConnectMethod) {
  const inputs: Record<string, string> = {}
  for (const prompt of method.prompts ?? []) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      if ((prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value) === false) continue
    }
    if (prompt.type === "select") {
      inputs[prompt.key] = yield* promptValue(
        yield* Prompt.select<string>({ message: prompt.message, options: [...prompt.options] }),
      )
      continue
    }
    inputs[prompt.key] = yield* promptValue(
      yield* Prompt.text({ message: prompt.message, placeholder: prompt.placeholder }),
    )
  }
  return inputs
})

const connect = Effect.fn("Cli.providers.connect")(function* (input: {
  integrations: Integration.Interface
  integration: Integration.Info
  methodName?: string
}) {
  const methods = input.integration.methods.filter((method) => method.type === "key" || method.type === "oauth")
  if (methods.length === 0) return yield* fail(`No supported V2 authentication method for ${input.integration.name}`)
  const method = yield* Effect.gen(function* () {
    if (input.methodName) {
      const match = methods.find((method) => {
        const label = method.type === "key" ? (method.label ?? "API key") : method.label
        return label.toLowerCase() === input.methodName!.toLowerCase()
      })
      if (match) return match
      return yield* fail(
        `Unknown method "${input.methodName}" for ${input.integration.name}. Available: ${methods
          .map((method) => (method.type === "key" ? (method.label ?? "API key") : method.label))
          .join(", ")}`,
      )
    }
    if (methods.length === 1) return methods[0]
    return yield* promptValue(
      yield* Prompt.select<number>({
        message: "Login method",
        options: methods.map((method, index) => ({
          label: method.type === "key" ? (method.label ?? "API key") : method.label,
          value: index,
        })),
      }),
    ).pipe(Effect.map((index) => methods[index]))
  })
  const inputs = yield* promptInputs(method)
  if (method.type === "key") {
    const key = yield* promptValue(
      yield* Prompt.password({
        message: "Enter your API key",
        validate: (value) => (value && value.length > 0 ? undefined : "Required"),
      }),
    )
    yield* input.integrations.connection.key({ integrationID: input.integration.id, key, inputs })
    yield* Prompt.outro("Done")
    return
  }

  const attempt = yield* input.integrations.connection.oauth({
    integrationID: input.integration.id,
    methodID: method.id,
    inputs,
  })
  yield* Prompt.log.info("Go to: " + attempt.url)
  if (attempt.instructions) yield* Prompt.log.info(attempt.instructions)
  if (attempt.mode === "code") {
    const code = yield* promptValue(
      yield* Prompt.text({
        message: "Paste the authorization code here: ",
        validate: (value) => (value && value.length > 0 ? undefined : "Required"),
      }),
    )
    yield* input.integrations.attempt.complete({ attemptID: attempt.attemptID, code })
    yield* Prompt.log.success("Login successful")
    yield* Prompt.outro("Done")
    return
  }

  const spinner = Prompt.spinner()
  yield* spinner.start("Waiting for authorization...")
  while (true) {
    const status = yield* input.integrations.attempt.status(attempt.attemptID)
    if (status.status === "pending") {
      yield* Effect.sleep("500 millis")
      continue
    }
    if (status.status === "complete") {
      yield* spinner.stop("Login successful")
      yield* Prompt.outro("Done")
      return
    }
    yield* spinner.stop(status.status === "failed" ? status.message : "Authorization expired", 1)
    return yield* fail(status.status === "failed" ? status.message : "Authorization expired")
  }
})

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: "manage AI providers and credentials",
  builder: (yargs) =>
    yargs.command(ProvidersListCommand).command(ProvidersLoginCommand).command(ProvidersLogoutCommand).demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers and credentials",
  // Lists global V2 credentials + provider env vars; no project instance needed.
  instance: false,
  handler: withLocationServices(Effect.fn("Cli.providers.list")(function* (_args) {
    const locations = yield* LocationServiceMap.Service
    const modelsDev = yield* ModelsDev.Service
    const location = yield* currentLocation
    const integrations = yield* Integration.Service.pipe(Effect.provide(locations.get(location)))

    UI.empty()
    yield* Prompt.intro("Credentials")
    const registered = yield* integrations.list()
    const results = yield* Effect.forEach(
      registered.flatMap((integration) =>
        integration.connections.flatMap((connection) =>
          connection.type === "credential" ? [{ integration, connection }] : [],
        ),
      ),
      (item) =>
        integrations.connection
          .resolve(item.connection)
          .pipe(
            Effect.map((value) => ({ ...item, value })),
            Effect.mapError((error) => new CliError({ message: `Failed to read credential: ${String(error)}` })),
          ),
    )
    const database = yield* modelsDev.get()

    for (const result of results) {
      const name = result.integration.name ?? database[result.integration.id]?.name ?? result.integration.id
      yield* Prompt.log.info(`${name} ${UI.Style.TEXT_DIM}${result.value?.type ?? "credential"}`)
    }

    yield* Prompt.outro(`${results.length} credentials`)

    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      yield* Prompt.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        yield* Prompt.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      yield* Prompt.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  })),
})

export const ProvidersLoginCommand = effectCmd({
  command: "login [url]",
  describe: "log in to a provider",
  // URL login skips instance bootstrap, which would load remote config with the stale token and crash before re-auth.
  instance: (args) => !args.url,
  builder: (yargs: Argv) =>
    yargs
      .positional("url", {
        describe: "zaovra auth provider",
        type: "string",
      })
      .option("provider", {
        alias: ["p"],
        describe: "provider id or name to log in to (skips provider selection)",
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: "login method label (skips method selection)",
        type: "string",
      }),
  handler: withLocationServices(Effect.fn("Cli.providers.login")(function* (args) {
    UI.empty()
    yield* Prompt.intro("Add credential")
    if (args.url) {
      return yield* fail(
        "URL-based well-known authentication is not supported by V2 Credential; configure a provider integration instead",
      )
    }

    const locations = yield* LocationServiceMap.Service
    const location = yield* currentLocation
    const services = yield* Effect.gen(function* () {
      return { catalog: yield* Catalog.Service, integrations: yield* Integration.Service }
    }).pipe(Effect.provide(locations.get(location)))
    const providers = yield* services.catalog.provider.all()

    const priority: Record<string, number> = {
      zaovra: 0,
      openai: 1,
      "github-copilot": 2,
      google: 3,
      anthropic: 4,
      openrouter: 5,
      vercel: 6,
    }
    const options = pipe(
      providers,
      sortBy(
        (provider) => priority[String(provider.id)] ?? 99,
        (provider) => provider.name,
      ),
      map((provider) => ({
        label: provider.name,
        value: String(provider.id),
        hint: {
          zaovra: "recommended",
          openai: "ChatGPT Plus/Pro or API key",
        }[String(provider.id) as "zaovra" | "openai"],
      })),
    )

    let provider: string
    if (args.provider) {
      const input = args.provider
      const byID = options.find((x) => x.value === input)
      const byName = options.find((x) => x.label.toLowerCase() === input.toLowerCase())
      const match = byID ?? byName
      if (!match) {
        return yield* fail(`Unknown provider "${input}"`)
      }
      provider = match.value
    } else {
      provider = yield* promptValue(
        yield* Prompt.autocomplete({
          message: "Select provider",
          maxItems: 8,
          options: [...options, { value: "other", label: "Other" }],
        }),
      )
    }

    if (provider === "other") {
      provider = (yield* promptValue(
        yield* Prompt.text({
          message: "Enter provider id",
          validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
        }),
      )).replace(/^@ai-sdk\//, "")
    }

    if (provider === "amazon-bedrock") {
      yield* Prompt.log.info(
        "Amazon Bedrock authentication priority:\n" +
          "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
          "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
          "Configure via zaovra.json options (profile, region, endpoint) or\n" +
          "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
      )
    }

    if (provider === "zaovra") {
      yield* Prompt.log.info("Create an api key at https://zaovra.com/auth")
    }

    if (provider === "vercel") {
      yield* Prompt.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
    }

    if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
      yield* Prompt.log.info(
        "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://zaovra.com/docs/providers/#cloudflare-ai-gateway",
      )
    }

    const providerInfo = yield* services.catalog.provider.get(ProviderV2.ID.make(provider))
    const integrationID = providerInfo?.integrationID ?? Integration.ID.make(provider)
    const integration = yield* services.integrations.get(integrationID)
    if (!integration) {
      return yield* fail(`Provider ${provider} has no registered V2 integration; configure it in zaovra.json first`)
    }
    yield* connect({ integrations: services.integrations, integration, methodName: args.method }).pipe(
      Effect.mapError((error) =>
        error instanceof CliError ? error : new CliError({ message: `Provider authentication failed: ${String(error)}` }),
      ),
    )
  })),
})

export const ProvidersLogoutCommand = effectCmd({
  command: "logout [provider]",
  describe: "log out from a configured provider",
  builder: (yargs) =>
    yargs.positional("provider", {
      describe: "provider id or name to log out from",
      type: "string",
    }),
  // Removes a global V2 credential; no project instance needed.
  instance: false,
  handler: withLocationServices(Effect.fn("Cli.providers.logout")(function* (args) {
    const locations = yield* LocationServiceMap.Service
    const modelsDev = yield* ModelsDev.Service
    const location = yield* currentLocation
    const integrations = yield* Integration.Service.pipe(Effect.provide(locations.get(location)))

    UI.empty()
    const registered = yield* integrations.list()
    const credentials = registered.flatMap((integration) =>
      integration.connections.flatMap((connection) =>
        connection.type === "credential" ? [{ integration, connection }] : [],
      ),
    )
    yield* Prompt.intro("Remove credential")
    if (credentials.length === 0) {
      yield* Prompt.log.error("No credentials found")
      return
    }
    const database = yield* modelsDev.get()
    const options = yield* Effect.forEach(credentials, (credential) =>
      integrations.connection.resolve(credential.connection).pipe(
        Effect.map((value) => ({
          label:
            (credential.integration.name ?? database[credential.integration.id]?.name ?? credential.integration.id) +
            UI.Style.TEXT_DIM +
            " (" +
            (value?.type ?? "credential") +
            ")",
          value: credential.connection.id,
          integrationID: credential.integration.id,
        })),
        Effect.mapError((error) => new CliError({ message: `Failed to read credential: ${String(error)}` })),
      ),
    )
    const credentialID = args.provider
      ? options.find(
          (option) =>
            option.integrationID === args.provider ||
            option.label.toLowerCase().startsWith(args.provider?.toLowerCase() ?? "") ||
            database[option.integrationID]?.name?.toLowerCase() === args.provider?.toLowerCase(),
        )?.value
      : yield* promptValue(
          yield* Prompt.autocomplete({
            message: "Select provider",
            maxItems: 8,
            options,
          }),
        )
    if (!credentialID) return yield* fail(`Unknown configured provider "${args.provider}"`)
    yield* integrations.connection
      .remove(credentialID)
      .pipe(Effect.mapError((error) => new CliError({ message: `Failed to remove credential: ${String(error)}` })))
    yield* Prompt.outro("Logout successful")
  })),
})
