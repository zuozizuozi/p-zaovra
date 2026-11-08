#!/usr/bin/env bun
import { Script } from "@zaovra-ai/script"
import { prepareReleaseNotes } from "./release-notes"

if (/-beta\.[1-9]\d*$/.test(Script.version)) await prepareReleaseNotes(Script.version)

await import("./prebuild")

const pkg = await Bun.file("./package.json").json()
pkg.version = Script.version
await Bun.write("./package.json", JSON.stringify(pkg, null, 2) + "\n")
console.log(`Updated package.json version to ${Script.version}`)
