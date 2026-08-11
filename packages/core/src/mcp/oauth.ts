import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { Cause, Deferred, Effect, Exit } from "effect"
import { Credential } from "../credential"
import { Integration } from "../integration"
import { OauthCallbackPage } from "../oauth/page"
import { ConfigMCP } from "../config/mcp"

const CALLBACK_PORT = 19_876
const CALLBACK_PATH = "/mcp/oauth/callback"

type Remote = ConfigMCP.Remote
type SaveCredential = (credential: Credential.OAuth) => Promise<void>

export function integrationID(name: string) {
  return Integration.ID.make(`mcp:${name}`)
}

export const methodID = Integration.MethodID.make("oauth")

export function implementation(name: string, server: Remote): Integration.OAuthImplementation {
  return {
    integrationID: integrationID(name),
    method: { id: methodID, type: "oauth", label: "OAuth" },
    authorize: () => authorize(name, server),
    refresh: (credential) => refresh(server, credential),
    label: () => `${name} OAuth`,
  }
}

export function oauthProvider(
  server: Remote,
  credential?: Credential.OAuth,
  saveCredential?: SaveCredential,
): OAuthClientProvider {
  return new Provider(server, credential, saveCredential)
}

class Provider implements OAuthClientProvider {
  private clientInfo: OAuthClientInformationMixed | undefined
  private tokenInfo: OAuthTokens | undefined
  private verifier: string | undefined
  private authorizationUrl: URL | undefined
  private readonly stateValue = crypto.randomUUID()

  constructor(
    private readonly server: Remote,
    credential?: Credential.OAuth,
    private readonly saveCredential?: SaveCredential,
  ) {
    this.clientInfo = configuredClient(server) ?? clientInformation(credential?.metadata)
    if (credential) this.tokenInfo = tokens(credential)
  }

  get redirectUrl() {
    return this.server.oauth && this.server.oauth.redirect_uri
      ? this.server.oauth.redirect_uri
      : `http://127.0.0.1:${this.server.oauth && this.server.oauth.callback_port ? this.server.oauth.callback_port : CALLBACK_PORT}${CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Zaovra",
      client_uri: "https://zaovra.com",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.server.oauth && this.server.oauth.client_secret ? "client_secret_post" : "none",
      ...(this.server.oauth && this.server.oauth.scope ? { scope: this.server.oauth.scope } : {}),
    }
  }

  state() {
    return this.stateValue
  }

  clientInformation() {
    return this.clientInfo
  }

  saveClientInformation(value: OAuthClientInformationMixed) {
    this.clientInfo = value
  }

  tokens() {
    return this.tokenInfo
  }

  async saveTokens(value: OAuthTokens) {
    this.tokenInfo = value
    if (this.saveCredential) await this.saveCredential(this.credential())
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }

  saveCodeVerifier(value: string) {
    this.verifier = value
  }

  codeVerifier() {
    if (!this.verifier) throw new Error("MCP OAuth code verifier is missing")
    return this.verifier
  }

  authorization() {
    return this.authorizationUrl
  }

  expectedState() {
    return this.stateValue
  }

  credential() {
    if (!this.tokenInfo) throw new Error("MCP OAuth did not return tokens")
    return Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: this.tokenInfo.access_token,
      refresh: this.tokenInfo.refresh_token ?? "",
      expires: this.tokenInfo.expires_in
        ? Date.now() + Math.max(0, Math.floor(this.tokenInfo.expires_in * 1_000))
        : Number.MAX_SAFE_INTEGER,
      metadata: {
        clientInformation: this.clientInfo,
        scope: this.tokenInfo.scope,
        tokenType: this.tokenInfo.token_type,
      },
    })
  }
}

function authorize(name: string, server: Remote) {
  return Effect.gen(function* () {
    const oauth = new Provider(server)
    const redirect = yield* Effect.try({ try: () => requireLoopback(oauth.redirectUrl), catch: normalizeError })
    const callback = yield* Deferred.make<string, Error>()
    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: redirect.hostname,
            port: Number(redirect.port),
            fetch(request) {
              const url = new URL(request.url)
              if (url.pathname !== redirect.pathname) return new Response("Not found", { status: 404 })
              if (url.searchParams.get("state") !== oauth.expectedState()) {
                const message = "Invalid or expired OAuth state"
                Effect.runFork(Deferred.fail(callback, new Error(message)))
                return html(OauthCallbackPage.error(message, { provider: `MCP ${name}` }), 400)
              }
              const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
              if (error) {
                Effect.runFork(Deferred.fail(callback, new Error(error)))
                return html(OauthCallbackPage.error(error, { provider: `MCP ${name}` }))
              }
              const code = url.searchParams.get("code")
              if (!code)
                return html(OauthCallbackPage.error("No authorization code provided", { provider: `MCP ${name}` }), 400)
              Effect.runFork(Deferred.succeed(callback, code))
              return html(OauthCallbackPage.success({ provider: `MCP ${name}` }))
            },
          }),
        catch: (cause) => new Error(`Unable to start MCP OAuth callback server: ${String(cause)}`),
      }),
      (running) => Effect.sync(() => running.stop(true)),
    )
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      authProvider: oauth,
      requestInit: server.headers ? { headers: server.headers } : undefined,
    })
    const client = new Client({ name: "zaovra", version: "1.18.3" }, { capabilities: {} })
    yield* Effect.addFinalizer(() => Effect.tryPromise(() => client.close()).pipe(Effect.ignore))
    const connected = yield* Effect.tryPromise({
      try: () => client.connect(transport),
      catch: normalizeError,
    }).pipe(Effect.exit)
    const url = oauth.authorization()
    if (!url) {
      if (Exit.isFailure(connected)) return yield* Effect.fail(normalizeError(Cause.squash(connected.cause)))
      return yield* Effect.fail(new Error(`MCP server does not require OAuth: ${name}`))
    }

    return {
      mode: "auto" as const,
      url: url.toString(),
      instructions: "Complete authorization in your browser. This window can remain open.",
      callback: Deferred.await(callback).pipe(
        Effect.flatMap((code) => Effect.tryPromise({ try: () => transport.finishAuth(code), catch: normalizeError })),
        Effect.map(() => oauth.credential()),
      ),
    }
  })
}

function refresh(server: Remote, credential: Credential.OAuth) {
  if (!credential.refresh) return Effect.fail(new Error("MCP OAuth credential cannot be refreshed"))
  return Effect.tryPromise({
    try: async () => {
      const oauth = new Provider(server, credential)
      const result = await auth(oauth, {
        serverUrl: server.url,
        scope: server.oauth && server.oauth.scope ? server.oauth.scope : undefined,
      })
      if (result !== "AUTHORIZED") throw new Error("MCP OAuth requires user authorization")
      return oauth.credential()
    },
    catch: normalizeError,
  })
}

function configuredClient(server: Remote): OAuthClientInformationMixed | undefined {
  if (!server.oauth || !server.oauth.client_id) return
  return {
    client_id: server.oauth.client_id,
    client_secret: server.oauth.client_secret,
  }
}

function clientInformation(
  metadata: Readonly<Record<string, unknown>> | undefined,
): OAuthClientInformationMixed | undefined {
  const value = metadata?.clientInformation
  if (!isRecord(value) || typeof value.client_id !== "string") return
  return {
    client_id: value.client_id,
    ...(typeof value.client_secret === "string" ? { client_secret: value.client_secret } : {}),
    ...(typeof value.client_id_issued_at === "number" ? { client_id_issued_at: value.client_id_issued_at } : {}),
    ...(typeof value.client_secret_expires_at === "number"
      ? { client_secret_expires_at: value.client_secret_expires_at }
      : {}),
  }
}

function tokens(credential: Credential.OAuth): OAuthTokens {
  return {
    access_token: credential.access,
    token_type: typeof credential.metadata?.tokenType === "string" ? credential.metadata.tokenType : "Bearer",
    ...(credential.refresh ? { refresh_token: credential.refresh } : {}),
    ...(credential.expires < Number.MAX_SAFE_INTEGER
      ? { expires_in: Math.max(0, Math.floor((credential.expires - Date.now()) / 1_000)) }
      : {}),
    ...(typeof credential.metadata?.scope === "string" ? { scope: credential.metadata.scope } : {}),
  }
}

function requireLoopback(value: string) {
  const url = new URL(value)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port) {
    throw new Error(`MCP OAuth redirect URI must be an HTTP loopback URL with a port: ${value}`)
  }
  return url
}

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error
  return new Error(String(error))
}
