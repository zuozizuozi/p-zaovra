import { readFile } from "node:fs/promises"
import path from "node:path"
import { Language, Parser, type Node } from "web-tree-sitter"
import runtime from "web-tree-sitter/tree-sitter.wasm" with { type: "file" }
import grammar from "tree-sitter-powershell/tree-sitter-powershell.wasm" with { type: "file" }

const asset = (file: string) => readFile(path.isAbsolute(file) ? file : new URL(file, import.meta.url))
let initialized: Promise<Language> | undefined

export async function operandText(command: string) {
  initialized ??= Promise.all([asset(runtime), asset(grammar)]).then(async ([binary, powershell]) => {
    await Parser.init({ wasmBinary: binary })
    return Language.load(powershell)
  })
  const language = await initialized
  const parser = new Parser().setLanguage(language)
  const tree = parser.parse(command)
  try {
    if (!tree || tree.rootNode.hasError) return command
    // Preserve offsets and mask only an individual quoted occurrence. A second
    // occurrence with the same value can be an actual filesystem operand.
    const spans = tree.rootNode
      .descendantsOfType("string_literal")
      .filter((node): node is Node => node !== null && isNonPathFragment(node))
    return spans.reduceRight(
      (text, node) =>
        text.slice(0, node.startIndex) + " ".repeat(node.endIndex - node.startIndex) + text.slice(node.endIndex),
      command,
    )
  } finally {
    tree?.delete()
    parser.delete()
  }
}

function isNonPathFragment(node: Node) {
  if (!/^(['"])\\[^\\/'"$`]*\1$/.test(node.text)) return false
  let expression = node
  while (
    expression.parent?.namedChildCount === 1 &&
    expression.parent.startIndex === expression.startIndex &&
    expression.parent.endIndex === expression.endIndex
  )
    expression = expression.parent
  const parent = expression.parent
  if (!parent) return false
  if (
    node.text.slice(1, -1) === "\\" &&
    parent.type.startsWith("additive_") &&
    parent.lastNamedChild?.id === expression.id &&
    parent.children.some((child) => child?.text === "+")
  ) {
    // The preceding expression already supplies the absolute directory.
    return /^\(\s*Resolve-Path\s+-LiteralPath\s+(['"])\.\1\s*\)\.Path$/i.test(parent.firstNamedChild?.text ?? "")
  }

  if (parent.type !== "argument_expression_list") return false
  const call = parent.parent?.parent
  if (!call || call.type !== "invokation_expression" || !stringReplace(call)) return false
  // Only a standalone display expression may discard these literal operands.
  // A replacement that feeds a command, assignment or redirection stays visible.
  let result = call
  while (result.parent) {
    const outer = result.parent
    if (outer.type === "statement_list") return outer.parent?.type === "program"
    if (outer.type === "invokation_expression" && outer.firstNamedChild?.id === result.id && stringReplace(outer)) {
      result = outer
      continue
    }
    if (
      (outer.namedChildCount === 1 && outer.text === result.text) ||
      (outer.type === "additive_expression" &&
        outer.lastNamedChild?.id === result.id &&
        outer.children.some((child) => child?.text === "+") &&
        /^"[^"$`]*"$/.test(outer.firstNamedChild?.text ?? ""))
    ) {
      result = outer
      continue
    }
    return false
  }
  return false
}

function stringReplace(call: Node): boolean {
  if (call.namedChild(1)?.text.toLowerCase() !== "replace") return false
  const receiver = call.firstNamedChild
  if (!receiver || receiver.type !== "invokation_expression") return false
  return (
    /^\[System\.Text\.Encoding\]::(?:ASCII|UTF8|Unicode)\.GetString$/i.test(
      receiver.firstNamedChild?.text + "." + receiver.namedChild(1)?.text,
    ) || stringReplace(receiver)
  )
}
