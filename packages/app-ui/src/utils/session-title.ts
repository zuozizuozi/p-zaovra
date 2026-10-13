const pattern = /^(New session|Child session) - (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/

export function sessionTitle(
  title: string | undefined,
  language: {
    intl: () => string
    t: (key: "command.session.new" | "session.title.child") => string
  },
) {
  if (!title) return title
  const match = title.match(pattern)
  if (!match) return title
  const date = new Date(match[2])
  if (Number.isNaN(date.getTime())) return title
  return `${language.t(match[1] === "Child session" ? "session.title.child" : "command.session.new")} ${new Intl.DateTimeFormat(
    language.intl(),
    {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
  ).format(date)}`
}
