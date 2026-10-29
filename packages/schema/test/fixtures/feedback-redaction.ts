export const redactionSamples = [
  {
    name: "access-token",
    marker: "SENTINEL_ACCESS_409",
    text: JSON.stringify({ message: "APPROVED_NOTE_409", account: [{ access_token: "SENTINEL_ACCESS_409" }] }),
  },
  {
    name: "refresh-token",
    marker: "SENTINEL_REFRESH_409",
    text: JSON.stringify({ message: "APPROVED_NOTE_409", credentials: { refresh_token: "SENTINEL_REFRESH_409" } }),
  },
  {
    name: "escaped-password",
    marker: "SENTINEL_PASSWORD_409",
    text: JSON.stringify({
      message: "APPROVED_NOTE_409",
      credentials: { password: 'prefix"SENTINEL_PASSWORD_409"suffix' },
    }),
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
