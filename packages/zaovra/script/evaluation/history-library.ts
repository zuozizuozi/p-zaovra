import path from "node:path"
import { mkdir, readFile, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync
const SourceEntry = Schema.Struct({ file: Schema.String, title: Schema.String, sha256: Schema.String })
const Draft = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  body: Schema.String,
  sources: Schema.Array(Schema.String),
})
const Document = Schema.Struct({ id: Schema.String, title: Schema.String, text: Schema.String })
const Corpus = Schema.Struct({
  documents: Schema.Array(Document),
  sources: Schema.Record(Schema.String, SourceEntry),
})
const PageDrafts = Schema.Struct({
  corpusHash: Schema.String,
  generator: Schema.String,
  pages: Schema.Array(Draft),
})
export type Document = typeof Document.Type
export type Corpus = typeof Corpus.Type
export type PageDrafts = typeof PageDrafts.Type

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
export const readJson = async <A, I>(file: string, schema: Schema.Codec<A, I>) =>
  decode(schema)(JSON.parse(await readFile(file, "utf8")))
export const fingerprint = (documents: ReadonlyArray<Document>) => sha256(JSON.stringify(documents))
export const historyText = (text: string) =>
  text.replace(/\b[a-z]:[\\/](?:Zaovra-研发记录|[a-z0-9_.-]+)(?:[\\/][a-z0-9_.-]+)*/gi, "[本机路径]")
export const corpusView = (documents: ReadonlyArray<Document>) =>
  documents.map((document) => ({ ...document, text: historyText(document.text) }))

// Prepare accepts only an explicit, pinned allowlist of original records.
export async function prepare(root: string, manifest: string, output: string) {
  const entries = await readJson(manifest, Schema.Array(SourceEntry))
  const base = await realpath(root)
  const seen = new Set<string>()
  const documents = []
  const sources: Record<string, typeof SourceEntry.Type> = {}
  for (const [index, entry] of entries.entries()) {
    const relative = entry.file.split("/")
    if (
      relative.length !== 2 ||
      relative.some((part) => !part || part === "." || part === "..") ||
      /[:\\]/.test(entry.file) ||
      !/\.(?:md|json)$/i.test(entry.file) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !entry.title.trim() ||
      entry.title.length > 100
    )
      throw new Error("invalid-corpus-entry")
    const file = await realpath(path.join(base, ...relative))
    const within = path.relative(base, file)
    if (within.startsWith(".." + path.sep) || path.isAbsolute(within) || seen.has(file))
      throw new Error("unexpected-corpus-source")
    seen.add(file)
    const data = await readFile(file)
    if (data.length === 0 || data.length > 65_536 || sha256(data) !== entry.sha256)
      throw new Error("corpus-hash-or-size-mismatch")
    const id = "doc-" + (index + 1)
    documents.push({
      id,
      title: entry.title,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data),
    })
    sources[id] = entry
  }
  if (documents.length === 0) throw new Error("empty-corpus")
  const view = corpusView(documents)
  await mkdir(output)
  await Bun.write(
    path.join(output, "generation-input.json"),
    JSON.stringify({ documents: view, corpusHash: fingerprint(view) }),
  )
  await Bun.write(path.join(output, "corpus.json"), JSON.stringify({ documents, sources }))
}

export async function loadCorpus(file: string) {
  const corpus = await readJson(file, Corpus)
  const ids = new Set(corpus.documents.map((document) => document.id))
  if (
    ids.size === 0 ||
    ids.size !== corpus.documents.length ||
    Object.keys(corpus.sources).length !== ids.size ||
    corpus.documents.some((document) => {
      const source = corpus.sources[document.id]
      return (
        !/^doc-[1-9]\d*$/.test(document.id) ||
        !source ||
        source.title !== document.title ||
        source.sha256 !== sha256(document.text)
      )
    })
  )
    throw new Error("corpus-integrity-mismatch")
  return corpus
}

export async function loadGeneration(input: string) {
  const generation = await readJson(
    input,
    Schema.Struct({ documents: Schema.Array(Document), corpusHash: Schema.String }),
  )
  if (
    generation.corpusHash !== fingerprint(generation.documents) ||
    !generation.documents.length ||
    generation.documents.some((doc, i) => doc.id !== "doc-" + (i + 1))
  )
    throw new Error("generation-input-mismatch")
  return generation
}

// Mechanical offline smoke-test pages use the same draft envelope.
export async function fixtureDrafts(input: string, output: string) {
  const generation = await loadGeneration(input)
  const pages = generation.documents.map((document) => ({
    title: document.title,
    summary: document.title,
    body: document.text.trim(),
    sources: [document.id],
  }))
  await Bun.write(output, JSON.stringify({ corpusHash: generation.corpusHash, generator: "offline-fixture", pages }))
}

export async function loadDrafts(file: string, corpus: Corpus) {
  const drafts = await readJson(file, PageDrafts)
  if (
    drafts.corpusHash !== fingerprint(corpusView(corpus.documents)) ||
    !drafts.generator.trim() ||
    !drafts.pages.length ||
    drafts.pages.some((page) => page.sources.some((id) => !Object.hasOwn(corpus.sources, id)))
  )
    throw new Error("draft-corpus-mismatch")
  return drafts
}
