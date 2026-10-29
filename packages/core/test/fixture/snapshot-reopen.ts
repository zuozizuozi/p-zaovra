import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Snapshot } from "@zaovra-ai/core/snapshot"
import { Effect } from "effect"
import path from "node:path"

const [directory, data] = Bun.argv.slice(2)
if (!directory || !data) throw new Error("Expected isolated project and snapshot storage")
const id = await Effect.runPromise(
  Snapshot.Service.use((snapshot) => snapshot.capture()).pipe(
    Effect.provide(
      AppNodeBuilder.build(Snapshot.node, [
        [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
        [Global.node, Global.layerWith({ data, config: path.join(data, "config") })],
      ]),
    ),
  ),
)
if (!id) throw new Error("Snapshot unavailable after reopening")
console.log(JSON.stringify({ id }))
