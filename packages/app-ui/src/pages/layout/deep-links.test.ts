import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { DEEP_LINK_PROTOCOLS, hasDeepLinkProtocol } from "../../deep-link-protocol"
import { parseDeepLink, parseNewSessionDeepLink } from "./deep-links"

describe("channel deep links", () => {
  test.each(["prod", "beta", "dev"] as const)("uses the compiled %s channel by default", async (channel) => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./deep-links.ts", import.meta.url))],
      target: "bun",
      define: { "import.meta.env.VITE_ZAOVRA_CHANNEL": JSON.stringify(channel) },
    })
    expect(result.success).toBe(true)
    const source = Buffer.from(await result.outputs[0].text()).toString("base64")
    const parser = await import(`data:text/javascript;base64,${source}`)
    const scheme = DEEP_LINK_PROTOCOLS[channel]
    expect(parser.collectOpenProjectDeepLinks([`${scheme}://open-project?directory=/tmp/demo`])).toEqual(["/tmp/demo"])
    expect(parser.collectNewSessionDeepLinks([`${scheme}://new-session?directory=/tmp/demo&prompt=hello`])).toEqual([
      { directory: "/tmp/demo", prompt: "hello" },
    ])
    const other = channel === "prod" ? "zaovra-beta" : "zaovra"
    expect(parser.collectOpenProjectDeepLinks([`${other}://open-project?directory=/tmp/demo`])).toEqual([])
  })

  test.each([
    ["prod", "zaovra"],
    ["beta", "zaovra-beta"],
    ["dev", "zaovra-dev"],
  ] as const)("routes only %s links to its own channel", (channel, scheme) => {
    expect(DEEP_LINK_PROTOCOLS[channel]).toBe(scheme)
    const project = `${scheme}://open-project?directory=${encodeURIComponent("F:/工作区/demo")}`
    const session = `${scheme}://new-session?directory=/tmp/demo&prompt=hello%20world`
    expect(hasDeepLinkProtocol(project, scheme)).toBe(true)
    expect(parseDeepLink(project, scheme)).toBe("F:/工作区/demo")
    expect(parseNewSessionDeepLink(session, scheme)).toEqual({ directory: "/tmp/demo", prompt: "hello world" })
    for (const other of ["zaovra", "zaovra-beta", "zaovra-dev"].filter((value) => value !== scheme)) {
      expect(hasDeepLinkProtocol(`${other}://open-project?directory=/tmp/demo`, scheme)).toBe(false)
      expect(parseDeepLink(`${other}://open-project?directory=/tmp/demo`, scheme)).toBeUndefined()
      expect(parseNewSessionDeepLink(`${other}://new-session?directory=/tmp/demo`, scheme)).toBeUndefined()
    }
    expect(hasDeepLinkProtocol(`${scheme}-other://open-project?directory=/tmp/demo`, scheme)).toBe(false)
    expect(parseDeepLink("https://example.com/open-project?directory=/tmp/demo", scheme)).toBeUndefined()
    expect(parseDeepLink(`${scheme}://open-project`, scheme)).toBeUndefined()
    expect(parseNewSessionDeepLink(`${scheme}://new-session`, scheme)).toBeUndefined()
  })
})
