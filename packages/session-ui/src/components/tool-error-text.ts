/** Keep the stored diagnostic intact; render only the command failure and stderr. */
export function toolErrorText(error: string) {
  const lines = error.replace(/^Error:\s*/, "").split(/\r?\n/)
  const frame = lines.findIndex(
    (line) =>
      /^\s*at\s/.test(line) &&
      /SessionRunner\.|ToolRegistry\.|[\\/]packages[\\/](?:core|llm)[\\/]src[\\/]|[\\/]effect[\\/]/.test(line),
  )
  return (frame < 0 ? lines : lines.slice(0, frame)).join("\n").trim()
}
