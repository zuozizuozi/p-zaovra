export * as WorkAccessFailure from "./access-failure"

export function recoverable(reason: string) {
  const message = reason.toLowerCase()
  return [
    "subscriptionrequired",
    "subscription required",
    "authentication",
    "autherror",
    "providerautherror",
    "unauthorized",
    "credential",
    "api key",
    "payment required",
    "status code 401",
    "status code 402",
  ].some((token) => message.includes(token))
}
