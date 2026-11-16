#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { generate } from "./generate"

const zaovra = path.resolve(dir, "../../zaovra")

await $`bun dev generate > ${dir}/openapi.json`.cwd(zaovra)

await generate(path.join(dir, "openapi.json"), path.join(dir, "src/v2/gen"))

await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
