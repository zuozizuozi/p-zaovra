import { showToast } from "./toast"
import { serverErrorDetails } from "./server-errors"

export function showServerError(error: unknown, title: string, translate: (key: string) => string) {
  // A status such as 499 alone does not prove that the user cancelled.
  const details = serverErrorDetails(error, translate)
  if (details === undefined) return
  showToast({
    variant: "error",
    title,
    description: translate("server.requestFailed"),
    actions: [
      {
        label: translate("server.errorDetails"),
        onClick: () => showToast({ title: translate("server.errorDetails"), description: details, persistent: true }),
      },
    ],
  })
}
