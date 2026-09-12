const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require("vscode-jsonrpc/node")
const fs = require("fs")
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
const record = (event) => fs.appendFileSync(process.argv[2], event + "\n")
connection.onRequest("initialize", () => {
  record("initialize")
  return { capabilities: { textDocumentSync: 1 } }
})
function publish(document, text) {
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri: document.uri,
    version: document.version,
    diagnostics: text.includes("bad")
      ? [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            severity: 1,
            message: "Bad text",
          },
        ]
      : [],
  })
}
connection.onNotification("textDocument/didOpen", (input) => {
  record("open")
  publish(input.textDocument, input.textDocument.text)
})
connection.onNotification("textDocument/didChange", (input) => {
  record("change")
  publish(input.textDocument, input.contentChanges[0].text)
})
connection.onNotification("textDocument/didClose", (input) => {
  record("close")
  // Deliberately send a stale report after close to exercise deletion handling.
  publish(
    {
      ...input.textDocument,
      uri: process.platform === "win32" ? input.textDocument.uri.toLowerCase() : input.textDocument.uri,
    },
    "bad",
  )
})
connection.listen()
