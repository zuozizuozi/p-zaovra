import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "@zaovra-ai/core/config"
import { ConfigMCP } from "@zaovra-ai/core/config/mcp"
import { ConfigMigrateV1 } from "@zaovra-ai/core/v1/config/migrate"
import { Integration } from "@zaovra-ai/core/integration"
import { Location } from "@zaovra-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@zaovra-ai/core/location-services"
import { MCP } from "@zaovra-ai/core/mcp"
import { integrationID } from "@zaovra-ai/core/mcp/oauth"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import path from "path"
import { Global } from "@zaovra-ai/core/global"
import { modify, applyEdits, parse } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { Effect, Exit } from "effect"

type AuthStatus = "authenticated" | "expired" | "not_authenticated"

function getAuthStatusIcon(status: AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "authenticated"
    case "expired":
      return "expired"
    case "not_authenticated":
      return "not authenticated"
  }
}

type McpConfigured = typeof ConfigMCP.Server.Type

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpConfigured): config is McpRemote {
  return config.type === "remote"
}

function configuredServers(config: ConfigMCP.Info | undefined) {
  return Object.entries(config?.servers ?? {})
}

function oauthServers(config: ConfigMCP.Info | undefined) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

const currentLocation = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

const withLocationServices =
  <Args, Value>(handler: (args: Args) => Effect.Effect<Value, CliError, LocationServiceMap.Service>) =>
  (args: Args) =>
    handler(args).pipe(Effect.provide(locationServiceMapLayer))

const services = Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  return yield* Effect.gen(function* () {
    return {
      config: yield* Config.Service,
      integrations: yield* Integration.Service,
      mcp: yield* MCP.Service,
    }
  }).pipe(Effect.provide(locations.get(currentLocation)))
})

const authorizationStatus = Effect.fn("Cli.mcp.authorizationStatus")(function* (
  integrations: Integration.Interface,
  name: string,
) {
  const integration = yield* integrations.get(integrationID(name))
  const connection = integration?.connections.find((item) => item.type === "credential")
  if (!connection) return "not_authenticated" as const
  const resolved = yield* integrations.connection.resolve(connection).pipe(Effect.exit)
  if (Exit.isFailure(resolved)) return "expired" as const
  if (resolved.value?.type !== "oauth") return "not_authenticated" as const
  return resolved.value.expires <= Date.now() ? ("expired" as const) : ("authenticated" as const)
})

function listState() {
  return Effect.gen(function* () {
    const runtime = yield* services
    const config = Config.latest(yield* runtime.config.entries(), "mcp")
    const statuses = yield* runtime.mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(
        oauthServers(config).map(([name]) => [
          name,
          runtime.integrations
            .get(integrationID(name))
            .pipe(
              Effect.map((integration) => integration?.connections.some((item) => item.type === "credential") ?? false),
            ),
        ]),
      ),
      { concurrency: "unbounded" },
    )
    return { config, statuses, stored, runtime }
  })
}

function authState() {
  return Effect.gen(function* () {
    const runtime = yield* services
    const config = Config.latest(yield* runtime.config.entries(), "mcp")
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, authorizationStatus(runtime.integrations, name)])),
      { concurrency: "unbounded" },
    )
    return { config, auth, runtime }
  })
}

export const McpCommand = cmd({
  command: "mcp",
  describe: "manage MCP (Model Context Protocol) servers",
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .demandCommand(),
  async handler() {},
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list MCP servers and their status",
  instance: false,
  handler: withLocationServices(
    Effect.fn("Cli.mcp.list")(function* () {
      UI.empty()
      prompts.intro("MCP Servers")

      const { config, statuses, stored } = yield* listState()
      const servers = configuredServers(config)

      if (servers.length === 0) {
        prompts.log.warn("No MCP servers configured")
        prompts.outro("Add servers with: zaovra mcp add")
        return
      }

      for (const [name, serverConfig] of servers) {
        const status = statuses[name]
        const hasOAuth = isMcpRemote(serverConfig) && serverConfig.oauth !== false
        const hasStoredTokens = stored[name]

        let statusIcon: string
        let statusText: string
        let hint = ""

        if (!status) {
          statusIcon = "○"
          statusText = "not initialized"
        } else if (status.status === "connected") {
          statusIcon = "✓"
          statusText = "connected"
          if (hasOAuth && hasStoredTokens) {
            hint = " (OAuth)"
          }
        } else if (status.status === "disabled") {
          statusIcon = "○"
          statusText = "disabled"
        } else if (status.status === "needs_auth") {
          statusIcon = "⚠"
          statusText = "needs authentication"
        } else {
          statusIcon = "✗"
          statusText = "failed"
          hint = "\n    " + status.error
        }

        const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
        prompts.log.info(
          `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
        )
      }

      prompts.outro(`${servers.length} server(s)`)
    }),
  ),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: "authenticate with an OAuth-enabled MCP server",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: withLocationServices(
    Effect.fn("Cli.mcp.auth")(function* (args) {
      UI.empty()
      prompts.intro("MCP OAuth Authentication")

      const { config, auth, runtime } = yield* authState()
      const mcpServers = config?.servers ?? {}
      const servers = oauthServers(config)

      if (servers.length === 0) {
        if (args.name) return yield* fail(`MCP server not found: ${args.name}`)
        prompts.log.warn("No OAuth-capable MCP servers configured")
        prompts.log.info("Remote MCP servers support OAuth by default. Add a remote server in zaovra.json:")
        prompts.log.info(`
  "mcp": {
    "servers": {
      "my-server": {
        "type": "remote",
        "url": "https://example.com/mcp"
      }
    }
  }`)
        prompts.outro("Done")
        return
      }

      let serverName = args.name
      if (!serverName) {
        const options = servers.map(([name, cfg]) => {
          const authStatus = auth[name]
          const icon = getAuthStatusIcon(authStatus)
          const statusText = getAuthStatusText(authStatus)
          const url = cfg.url
          return {
            label: `${icon} ${name} (${statusText})`,
            value: name,
            hint: url,
          }
        })

        const selected = yield* Effect.promise(() =>
          prompts.select({
            message: "Select MCP server to authenticate",
            options,
          }),
        )
        if (prompts.isCancel(selected)) throw new UI.CancelledError()
        serverName = selected
      }

      const serverConfig = mcpServers[serverName]
      if (!serverConfig) return yield* fail(`MCP server not found: ${serverName}`)
      if (!isMcpRemote(serverConfig) || serverConfig.oauth === false)
        return yield* fail(`MCP server ${serverName} is not an OAuth-capable remote server`)

      const integration = yield* runtime.integrations.get(integrationID(serverName))
      const method = integration?.methods.find((item) => item.type === "oauth")
      if (!method || method.type !== "oauth")
        return yield* fail(`MCP server ${serverName} has no registered V2 OAuth integration`)
      const authStatus = auth[serverName] ?? (yield* authorizationStatus(runtime.integrations, serverName))
      if (authStatus === "authenticated") {
        const confirm = yield* Effect.promise(() =>
          prompts.confirm({
            message: `${serverName} already has valid credentials. Re-authenticate?`,
          }),
        )
        if (prompts.isCancel(confirm) || !confirm) {
          prompts.outro("Cancelled")
          return
        }
      } else if (authStatus === "expired") {
        prompts.log.warn(`${serverName} has expired credentials. Re-authenticating...`)
      }

      const spinner = prompts.spinner()
      spinner.start("Starting OAuth flow...")
      const attempt = yield* runtime.integrations.connection
        .oauth({ integrationID: integrationID(serverName), methodID: method.id, inputs: {} })
        .pipe(
          Effect.mapError((error) => new CliError({ message: `Unable to start MCP OAuth: ${String(error.cause)}` })),
        )
      spinner.stop("Authorize in your browser:")
      prompts.log.info(attempt.url)
      if (attempt.instructions) prompts.log.info(attempt.instructions)
      yield* Effect.promise(async () => {
        const { default: open } = await import("open")
        await open(attempt.url).catch(() => undefined)
      })
      spinner.start("Waiting for authorization...")
      while (true) {
        const status = yield* runtime.integrations.attempt.status(attempt.attemptID)
        if (status.status === "pending") {
          yield* Effect.sleep("500 millis")
          continue
        }
        if (status.status === "failed") {
          spinner.stop("Authentication failed", 1)
          return yield* fail(status.message)
        }
        if (status.status === "expired") {
          spinner.stop("Authentication expired", 1)
          return yield* fail("MCP authorization expired")
        }
        break
      }
      yield* runtime.mcp
        .reconnect(serverName)
        .pipe(Effect.mapError(() => new CliError({ message: `MCP server is not configured: ${serverName}` })))
      const status = (yield* runtime.mcp.status())[serverName]
      if (status?.status !== "connected") {
        spinner.stop("Authentication failed", 1)
        return yield* fail(
          status?.status === "failed" || status?.status === "needs_auth" ? status.error : "MCP did not connect",
        )
      }
      spinner.stop("Authentication successful!")

      prompts.outro("Done")
    }),
  ),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OAuth-capable MCP servers and their auth status",
  instance: false,
  handler: withLocationServices(
    Effect.fn("Cli.mcp.auth.list")(function* () {
      UI.empty()
      prompts.intro("MCP OAuth Status")

      const { config, auth } = yield* authState()
      const servers = oauthServers(config)

      if (servers.length === 0) {
        prompts.log.warn("No OAuth-capable MCP servers configured")
        prompts.outro("Done")
        return
      }

      for (const [name, serverConfig] of servers) {
        const authStatus = auth[name]
        const icon = getAuthStatusIcon(authStatus)
        const statusText = getAuthStatusText(authStatus)
        const url = serverConfig.url

        prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
      }

      prompts.outro(`${servers.length} OAuth-capable server(s)`)
    }),
  ),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: "remove OAuth credentials for an MCP server",
  instance: false,
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
    }),
  handler: withLocationServices(
    Effect.fn("Cli.mcp.logout")(function* (args) {
      UI.empty()
      prompts.intro("MCP OAuth Logout")

      const runtime = yield* services
      const config = Config.latest(yield* runtime.config.entries(), "mcp")
      const credentials = (yield* Effect.forEach(oauthServers(config), ([name]) =>
        runtime.integrations
          .get(integrationID(name))
          .pipe(
            Effect.map((integration) =>
              (integration?.connections ?? []).flatMap((connection) =>
                connection.type === "credential" ? [{ name, connection }] : [],
              ),
            ),
          ),
      )).flat()

      if (credentials.length === 0) {
        if (args.name) return yield* fail(`No V2 MCP credential found for: ${args.name}`)
        prompts.log.warn("No MCP OAuth credentials stored")
        prompts.outro("Done")
        return
      }

      let serverName = args.name
      if (!serverName) {
        const selected = yield* Effect.promise(() =>
          prompts.select({
            message: "Select MCP server to logout",
            options: credentials.map((item) => ({
              label: item.name,
              value: item.name,
              hint: item.connection.label,
            })),
          }),
        )
        if (prompts.isCancel(selected)) throw new UI.CancelledError()
        serverName = selected
      }

      const credential = credentials.find((item) => item.name === serverName)
      if (!credential) return yield* fail(`No V2 MCP credential found for: ${serverName}`)
      yield* runtime.integrations.connection.remove(credential.connection.id)
      yield* runtime.mcp
        .reconnect(serverName)
        .pipe(Effect.mapError(() => new CliError({ message: `MCP server is not configured: ${serverName}` })))
      prompts.log.success(`Removed OAuth credentials for ${serverName}`)
      prompts.outro("Done")
    }),
  ),
})

async function resolveConfigPath(baseDir: string, global = false) {
  // Check for existing config files (prefer .jsonc over .json, check .zaovra/ subdirectory too)
  const candidates = [path.join(baseDir, "zaovra.json"), path.join(baseDir, "zaovra.jsonc")]

  if (!global) {
    candidates.push(path.join(baseDir, ".zaovra", "zaovra.json"), path.join(baseDir, ".zaovra", "zaovra.jsonc"))
  }

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  // Default to zaovra.json if none exist
  return candidates[0]
}

async function addMcpToConfig(name: string, mcpConfig: McpConfigured, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }

  const document: unknown = parse(text)
  const legacy = ConfigMigrateV1.isV1(document)
  const value = legacy ? legacyMcpConfig(mcpConfig) : mcpConfig
  const edits = modify(text, legacy ? ["mcp", name] : ["mcp", "servers", name], value, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)

  await Filesystem.write(configPath, result)

  return configPath
}

function legacyMcpConfig(config: McpConfigured) {
  if (config.type === "local") {
    return {
      type: config.type,
      command: config.command,
      cwd: config.cwd,
      environment: config.environment,
      enabled: config.disabled === undefined ? undefined : !config.disabled,
      timeout: config.timeout?.request,
    }
  }
  return {
    type: config.type,
    url: config.url,
    headers: config.headers,
    oauth: config.oauth && {
      clientId: config.oauth.client_id,
      clientSecret: config.oauth.client_secret,
      scope: config.oauth.scope,
      callbackPort: config.oauth.callback_port,
      redirectUri: config.oauth.redirect_uri,
    },
    enabled: config.disabled === undefined ? undefined : !config.disabled,
    timeout: config.timeout?.request,
  }
}

export const McpAddCommand = effectCmd({
  command: "add [name]",
  describe: "add an MCP server",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .option("url", {
        describe: "URL for a remote MCP server",
        type: "string",
      })
      .option("env", {
        describe: "environment variable for a local MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "HTTP header for a remote MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      }),
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    yield* Effect.promise(async () => {
      const command = args["--"] ?? []
      if (!args.name && (args.url || args.env?.length || args.header?.length || command.length)) {
        throw new Error("A server name is required for non-interactive MCP configuration")
      }
      if (args.name) {
        if (!!args.url === !!command.length) {
          throw new Error("Provide either --url <url> or a command after --")
        }
        if (args.url && !URL.canParse(args.url)) {
          throw new Error(`Invalid URL: ${args.url}`)
        }
        if (args.url && args.env?.length) {
          throw new Error("--env is only valid for local MCP servers")
        }
        if (command.length && args.header?.length) {
          throw new Error("--header is only valid for remote MCP servers")
        }

        const entries = (values: string[], kind: string) =>
          Object.fromEntries(
            values.map((entry) => {
              const index = entry.indexOf("=")
              if (index < 1) throw new Error(`Invalid ${kind}: ${entry}. Expected KEY=VALUE`)
              return [entry.slice(0, index), entry.slice(index + 1)]
            }),
          )
        const environment = entries(args.env ?? [], "environment variable")
        const headers = entries(args.header ?? [], "HTTP header")
        const mcpConfig: McpConfigured = args.url
          ? {
              type: "remote",
              url: args.url,
              ...(Object.keys(headers).length ? { headers } : {}),
            }
          : {
              type: "local",
              command,
              ...(Object.keys(environment).length ? { environment } : {}),
            }

        const configPath = await resolveConfigPath(Global.Path.config, true)
        await addMcpToConfig(args.name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${args.name}" added to ${configPath}`)
        return
      }

      UI.empty()
      prompts.intro("Add MCP server")

      const [projectConfigPath, globalConfigPath] = await Promise.all([
        resolveConfigPath(process.cwd()),
        resolveConfigPath(Global.Path.config, true),
      ])

      const configPath = await prompts.select({
        message: "Location",
        options: [
          {
            label: "Current directory",
            value: projectConfigPath,
            hint: projectConfigPath,
          },
          {
            label: "Global",
            value: globalConfigPath,
            hint: globalConfigPath,
          },
        ],
      })
      if (prompts.isCancel(configPath)) throw new UI.CancelledError()

      const name = await prompts.text({
        message: "Enter MCP server name",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(name)) throw new UI.CancelledError()

      const type = await prompts.select({
        message: "Select MCP server type",
        options: [
          {
            label: "Local",
            value: "local",
            hint: "Run a local command",
          },
          {
            label: "Remote",
            value: "remote",
            hint: "Connect to a remote URL",
          },
        ],
      })
      if (prompts.isCancel(type)) throw new UI.CancelledError()

      if (type === "local") {
        const command = await prompts.text({
          message: "Enter command to run",
          placeholder: "e.g., zaovra x @modelcontextprotocol/server-filesystem",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(command)) throw new UI.CancelledError()

        const mcpConfig: McpConfigured = {
          type: "local",
          command: command.split(" "),
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${name}" added to ${configPath}`)
        prompts.outro("MCP server added successfully")
        return
      }

      if (type === "remote") {
        const url = await prompts.text({
          message: "Enter MCP server URL",
          placeholder: "e.g., https://example.com/mcp",
          validate: (x) => {
            if (!x) return "Required"
            if (x.length === 0) return "Required"
            const isValid = URL.canParse(x)
            return isValid ? undefined : "Invalid URL"
          },
        })
        if (prompts.isCancel(url)) throw new UI.CancelledError()

        const useOAuth = await prompts.confirm({
          message: "Does this server require OAuth authentication?",
          initialValue: false,
        })
        if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

        let mcpConfig: McpConfigured

        if (useOAuth) {
          const hasClientId = await prompts.confirm({
            message: "Do you have a pre-registered client ID?",
            initialValue: false,
          })
          if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

          if (hasClientId) {
            const clientId = await prompts.text({
              message: "Enter client ID",
              validate: (x) => (x && x.length > 0 ? undefined : "Required"),
            })
            if (prompts.isCancel(clientId)) throw new UI.CancelledError()

            const hasSecret = await prompts.confirm({
              message: "Do you have a client secret?",
              initialValue: false,
            })
            if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

            let clientSecret: string | undefined
            if (hasSecret) {
              const secret = await prompts.password({
                message: "Enter client secret",
              })
              if (prompts.isCancel(secret)) throw new UI.CancelledError()
              clientSecret = secret
            }

            mcpConfig = {
              type: "remote",
              url,
              oauth: {
                client_id: clientId,
                ...(clientSecret && { client_secret: clientSecret }),
              },
            }
          } else {
            mcpConfig = {
              type: "remote",
              url,
              oauth: {},
            }
          }
        } else {
          mcpConfig = {
            type: "remote",
            url,
            oauth: false,
          }
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${name}" added to ${configPath}`)
      }

      prompts.outro("MCP server added successfully")
    })
  }),
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: "debug OAuth connection for an MCP server",
  instance: false,
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  handler: withLocationServices(
    Effect.fn("Cli.mcp.debug")(function* (args) {
      const runtime = yield* services
      const config = Config.latest(yield* runtime.config.entries(), "mcp")
      const serverConfig = config?.servers?.[args.name]
      if (!serverConfig) return yield* fail(`MCP server not found: ${args.name}`)
      if (!isMcpRemote(serverConfig)) return yield* fail(`MCP server ${args.name} is not a remote server`)
      if (serverConfig.oauth === false) return yield* fail(`MCP server ${args.name} has OAuth explicitly disabled`)

      UI.empty()
      prompts.intro("MCP OAuth Debug")
      prompts.log.info(`Server: ${args.name}`)
      prompts.log.info(`URL: ${serverConfig.url}`)
      const authStatus = yield* authorizationStatus(runtime.integrations, args.name)
      prompts.log.info(`Auth status: ${getAuthStatusIcon(authStatus)} ${getAuthStatusText(authStatus)}`)
      const integration = yield* runtime.integrations.get(integrationID(args.name))
      const connection = integration?.connections.find((item) => item.type === "credential")
      prompts.log.info(connection ? `Credential: ${connection.label}` : "Credential: none")

      const spinner = prompts.spinner()
      spinner.start("Testing V2 MCP connection...")
      yield* runtime.mcp
        .reconnect(args.name)
        .pipe(Effect.mapError(() => new CliError({ message: `MCP server is not configured: ${args.name}` })))
      const status = (yield* runtime.mcp.status())[args.name]
      if (status?.status === "connected") {
        spinner.stop(`Connected with ${status.tools} tool(s)`)
        prompts.outro("Debug complete")
        return
      }
      spinner.stop("Connection failed", 1)
      if (status?.status === "needs_auth") {
        prompts.log.info(`Integration: ${status.integrationID}`)
        prompts.log.info(`Method: ${status.methodID}`)
        return yield* fail(status.error)
      }
      if (status?.status === "failed") return yield* fail(status.error)
      return yield* fail(status ? `Unexpected MCP status: ${status.status}` : "MCP status is unavailable")
    }),
  ),
})
