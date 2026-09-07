import { AuthError } from "./error"

export function requireApiKey(value: string | undefined) {
  if (!value || value === "public") {
    throw new AuthError("Connect your own provider or subscribe to ZAOVRA to use managed models.")
  }
  return value
}
