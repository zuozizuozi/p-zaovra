import { formatServerError } from "./server-errors"

export function formatRevertError(error: unknown, translate: (key: string) => string) {
  const cause = error instanceof Error ? error.cause : undefined
  const body = cause && typeof cause === "object" && "body" in cause ? cause.body : error
  if (body && typeof body === "object") {
    if ("resource" in body && body.resource === "revert-plan") return translate("session.revert.planChanged")
    if (
      "_tag" in body &&
      ["UnknownError", "ConflictError"].includes(String(body._tag)) &&
      "message" in body &&
      typeof body.message === "string"
    )
      return body.message
  }
  return translate("session.revert.restoreFailed") + " " + formatServerError(error, translate)
}
