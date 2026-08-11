export async function completeMcpOAuth(input: {
  begin: () => Promise<{ attemptID: string; url: string }>
  open: (url: string) => Promise<unknown>
  status: (
    attemptID: string,
  ) => Promise<
    { status: "pending" } | { status: "complete" } | { status: "failed"; message: string } | { status: "expired" }
  >
  ready?: () => Promise<boolean>
  connect: () => Promise<void>
  delay?: (milliseconds: number) => Promise<void>
}) {
  const attempt = await input.begin()
  await input.open(attempt.url)
  const delay =
    input.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  while (true) {
    const status = await input.status(attempt.attemptID)
    if (status.status === "complete") {
      if (input.ready) {
        for (let attempt = 0; !(await input.ready()); attempt++) {
          if (attempt >= 119) throw new Error("MCP credential was not saved after authorization")
          await delay(500)
        }
      }
      await input.connect()
      return
    }
    if (status.status === "failed") throw new Error(status.message)
    if (status.status === "expired") throw new Error("MCP authorization expired")
    await delay(500)
  }
}
