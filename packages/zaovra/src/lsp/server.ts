import { LSPBuiltins } from "@zaovra-ai/core/lsp/builtins"
import { Filesystem } from "@/util/filesystem"
import { Archive } from "@/util/archive"
import { Process } from "@/util/process"
import { spawn } from "./launch"

export type Handle = LSPBuiltins.Handle
export type Info = LSPBuiltins.Info

const servers = LSPBuiltins.create({ filesystem: Filesystem, archive: Archive, process: Process, spawn })

export const Deno = servers.Deno
export const Typescript = servers.Typescript
export const Vue = servers.Vue
export const ESLint = servers.ESLint
export const Oxlint = servers.Oxlint
export const Biome = servers.Biome
export const Gopls = servers.Gopls
export const Rubocop = servers.Rubocop
export const Ty = servers.Ty
export const Pyright = servers.Pyright
export const ElixirLS = servers.ElixirLS
export const Zls = servers.Zls
export const CSharp = servers.CSharp
export const Razor = servers.Razor
export const FSharp = servers.FSharp
export const SourceKit = servers.SourceKit
export const RustAnalyzer = servers.RustAnalyzer
export const Clangd = servers.Clangd
export const Svelte = servers.Svelte
export const Astro = servers.Astro
export const JDTLS = servers.JDTLS
export const KotlinLS = servers.KotlinLS
export const YamlLS = servers.YamlLS
export const LuaLS = servers.LuaLS
export const PHPIntelephense = servers.PHPIntelephense
export const Prisma = servers.Prisma
export const Dart = servers.Dart
export const Ocaml = servers.Ocaml
export const BashLS = servers.BashLS
export const TerraformLS = servers.TerraformLS
export const TexLab = servers.TexLab
export const DockerfileLS = servers.DockerfileLS
export const Gleam = servers.Gleam
export const Clojure = servers.Clojure
export const Nixd = servers.Nixd
export const Tinymist = servers.Tinymist
export const HLS = servers.HLS
export const JuliaLS = servers.JuliaLS
