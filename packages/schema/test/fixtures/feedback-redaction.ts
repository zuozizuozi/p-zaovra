export const redactionSamples = [
  {
    name: "access-token",
    marker: "SENTINEL_ACCESS_409",
    text: JSON.stringify({ message: "APPROVED_NOTE_409", account: [{ access_token: "SENTINEL_ACCESS_409" }] }),
    preserve: [],
  },
  {
    name: "refresh-token",
    marker: "SENTINEL_REFRESH_409",
    text: JSON.stringify({ message: "APPROVED_NOTE_409", credentials: { refresh_token: "SENTINEL_REFRESH_409" } }),
    preserve: [],
  },
  {
    name: "escaped-password",
    marker: "SENTINEL_PASSWORD_409",
    text: JSON.stringify({
      message: "APPROVED_NOTE_409",
      credentials: { password: 'prefix"SENTINEL_PASSWORD_409"suffix' },
    }),
    preserve: [],
  },
  {
    name: "diagnostic-lines",
    marker: "SENTINEL_DIAGNOSTIC_410",
    text: 'APPROVED_NOTE_409\nERROR: request failed with status 503; retry after 30 seconds\nENOENT: required file missing\nHTTP 503: service unavailable\npassword="SENTINEL_DIAGNOSTIC_410"',
    preserve: [
      "ERROR: request failed with status 503; retry after 30 seconds",
      "ENOENT: required file missing",
      "HTTP 503: service unavailable",
    ],
  },
  {
    name: "paired-value",
    marker: "SENTINEL_PAIR_410",
    text: 'APPROVED_NOTE_409\ntoken=[one,two,{"nested":["SENTINEL_PAIR_410","a]b"]}]\nReproduction: click export twice\nExpected: archive saved',
    preserve: ["Reproduction: click export twice", "Expected: archive saved"],
  },
]
export const redactionInputs = ["description", "details", "conversation", "code"] as const
export const credentialFields = [
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "api_key",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "proxy_authorization",
  "cookie",
  "set_cookie",
  "private_key",
]
