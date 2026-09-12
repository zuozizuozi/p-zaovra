import { FormatterBuiltins } from "@zaovra-ai/core/formatter/builtins"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"

export type Context = FormatterBuiltins.Context
export type Info = FormatterBuiltins.Info

const builtins = FormatterBuiltins.create({
  findUp: Filesystem.findUp,
  readJson: Filesystem.readJson,
  readText: Filesystem.readText,
  probe: (command) => Process.text(command, { nothrow: true }),
})
export const gofmt = builtins.gofmt
export const mix = builtins.mix
export const prettier = builtins.prettier
export const oxfmt = builtins.oxfmt
export const biome = builtins.biome
export const zig = builtins.zig
export const clang = builtins.clang
export const ktlint = builtins.ktlint
export const ruff = builtins.ruff
export const rlang = builtins.rlang
export const uvformat = builtins.uvformat
export const rubocop = builtins.rubocop
export const standardrb = builtins.standardrb
export const htmlbeautifier = builtins.htmlbeautifier
export const dart = builtins.dart
export const ocamlformat = builtins.ocamlformat
export const terraform = builtins.terraform
export const latexindent = builtins.latexindent
export const gleam = builtins.gleam
export const shfmt = builtins.shfmt
export const nixfmt = builtins.nixfmt
export const rustfmt = builtins.rustfmt
export const pint = builtins.pint
export const ormolu = builtins.ormolu
export const cljfmt = builtins.cljfmt
export const dfmt = builtins.dfmt
