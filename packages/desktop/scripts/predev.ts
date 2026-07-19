import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.ZAOVRA_CHANNEL ?? "dev"}`

await $`cd ../zaovra && bun script/build-node.ts`
