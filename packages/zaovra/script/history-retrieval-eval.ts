// Standalone harness. No provider setup or live mode is available from this CLI.
import { fixtureDrafts, prepare } from "./evaluation/history-library"

const [phase, ...args] = Bun.argv.slice(2)
if (phase === "prepare" && args.length === 3) {
  await prepare(args[0], args[1], args[2])
} else if (phase === "fixture-drafts" && args.length === 2) {
  await fixtureDrafts(args[0], args[1])
} else if (phase === "offline" && args.length === 4) {
  const { evaluate, offlineResponder } = await import("./evaluation/history-run")
  await evaluate({ corpus: args[0], drafts: args[1], questions: args[2], output: args[3] }, offlineResponder)
} else {
  throw new Error(
    "history-retrieval-eval: prepare <records> <manifest> <new-dir> | " +
      "fixture-drafts <generation-input> <drafts> | offline <corpus> <drafts> <questions> <new-dir>",
  )
}
