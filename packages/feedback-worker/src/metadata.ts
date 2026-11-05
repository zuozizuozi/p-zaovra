import { Feedback } from "../../schema/src/feedback"

export const feedbackReceipt = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function feedbackMetadata(receipt: string, value: unknown) {
  if (!feedbackReceipt.test(receipt) || !value || typeof value !== "object") throw new Error("Invalid feedback record")
  if (
    !("received" in value) ||
    typeof value.received !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.received) ||
    !Number.isFinite(Date.parse(value.received)) ||
    new Date(value.received).toISOString() !== value.received
  )
    throw new Error("Invalid feedback time")
  if (!("snapshot" in value) || !value.snapshot || typeof value.snapshot !== "object")
    throw new Error("Invalid snapshot")
  const snapshot = value.snapshot
  const files: unknown[] = "files" in snapshot && Array.isArray(snapshot.files) ? snapshot.files : []
  const file = files.find((item) =>
    Boolean(item && typeof item === "object" && "name" in item && item.name === "report.json"),
  )
  const text =
    "text" in snapshot && typeof snapshot.text === "string"
      ? snapshot.text
      : file && typeof file === "object" && "text" in file && typeof file.text === "string"
        ? file.text
        : undefined
  // Stored text can grow during redaction/pretty-printing; only the projected summary is truncated here.
  if (typeof text !== "string") throw new Error("Invalid report text")
  const report: unknown = JSON.parse(text)
  if (!report || typeof report !== "object" || !("reportID" in report) || report.reportID !== receipt)
    throw new Error("Report does not match its receipt")
  const environment =
    "environment" in report && report.environment && typeof report.environment === "object"
      ? report.environment
      : undefined
  const version =
    environment &&
    "version" in environment &&
    typeof environment.version === "string" &&
    /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/.test(environment.version)
      ? environment.version
      : "unknown"
  // Older reports have no explicit channel. A stable-looking version may still be a Dev build.
  const channel =
    environment && "channel" in environment && ["beta", "dev", "prod"].includes(String(environment.channel))
      ? String(environment.channel)
      : /-beta\.\d+$/.test(version)
        ? "beta"
        : "unknown"
  const summary = Array.from(
    Feedback.redact(
      "description" in report && typeof report.description === "string" ? report.description : "",
    ).replace(/[\u0000-\u001f\u007f]/g, " "),
  )
    .slice(0, 100)
    .join("")
  return {
    receipt,
    received: new Date(value.received).toISOString(),
    version,
    channel,
    summary,
    url: "https://feedback.zaovra.com/admin/report/" + receipt,
  }
}
