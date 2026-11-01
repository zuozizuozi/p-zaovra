const {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
} = require("vscode-jsonrpc/node")
require("node:fs").writeFileSync(process.argv[2], String(process.pid))
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
connection.onRequest("initialize", () => {
  throw new ResponseError(-32603, "fixture initialization rejected")
})
connection.listen()
