import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.ZAOVRA_CHANNEL ?? "dev"}`

await $`bun ../zaovra/script/build-node.ts`
