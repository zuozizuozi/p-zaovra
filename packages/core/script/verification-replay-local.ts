// Read-only replay of archived evidence; does not invoke models or run submitted commands.
import { Schema } from "effect"
import { createHash } from "node:crypto"
import path from "node:path"
import { SessionMessage } from "../src/session/message"
import { SessionOutcome } from "../src/session/outcome"

const root = process.argv[2]
if (!root) throw new Error("Expected the archived evidence directory")
const results = (await Bun.file(`${root}/results.json`).json()) as {
  id: string
  directory: string
  finishReason: string
  cwd: string
}[]
for (const run of results) {
  const messages = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Message))(
    (await Bun.file(`${run.directory}/context.json`).json()).data,
  )
  const preliminary = SessionOutcome.derive(messages, false)
  const paths = [
    ...new Set(
      preliminary.checks.flatMap((check) =>
        [...(check.targets ?? []), ...(check.assertions ?? [])].map((file) => file.path),
      ),
    ),
  ]
  const targets = await Promise.all(
    paths.map(async (path) => ({
      path,
      digest: await Bun.file(process.argv.includes("--archived") ? archivedPath(run, path) : path)
        .arrayBuffer()
        .then(
          (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
          () => "",
        ),
    })),
  )
  const outcome = SessionOutcome.derive(messages, false, undefined, targets, ["test", "build"])
  console.log(
    JSON.stringify({
      id: run.id,
      recordedState: run.finishReason,
      artifactSource: process.argv.includes("--archived") ? "submission-before-judge" : "workspace",
      replayState: outcome.state,
      missing: outcome.missing,
      unresolved: outcome.checks
        .filter((check) => check.exit !== 0 && !check.supersededBy)
        .map((check) => ({ callID: check.callID, execution: check.execution, exit: check.exit })),
    }),
  )
}

function archivedPath(run: { cwd: string; directory: string }, file: string) {
  const relative = path.relative(run.cwd, file)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`Evidence path is outside the submitted workspace: ${file}`)
  return path.join(run.directory, "submission-before-judge", relative)
}
