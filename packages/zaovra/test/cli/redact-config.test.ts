import { expect, test } from "bun:test"
import { redactConfig } from "../../src/cli/cmd/debug/redact-config"

test("debug config masks nested credentials and URLs without mutating configuration", () => {
  const config = {
    model: "provider/model",
    provider: { options: { apiKey: "secret-one", headers: { custom: "secret-two" } } },
    mcp: [
      {
        environment: { CUSTOM_AUTH: "secret-three" },
        url: "https://user:secret-four@example.com/api?custom=secret-five",
      },
    ],
    refreshToken: "secret-six",
  }
  const output = JSON.stringify(redactConfig(config))
  expect(output).not.toContain("secret-")
  expect(output).not.toContain("https://user:")
  expect(output).toContain("provider/model")
  expect(output).toContain("example.com/api")
  expect(config.provider.options.apiKey).toBe("secret-one")
})
