import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { chromium } from "playwright-core"
import { BrowserNetwork } from "../src/tool/browser-network"

test("workers are disabled before scripts in inherited and cross-origin frames; main-thread sockets remain authorized", { timeout: 30000 }, async () => {
  const forbidden: string[] = []
  const attempts: string[] = []
  const allowed: string[] = []
  const outside = createServer((request, response) => { forbidden.push(request.url!); response.end("forbidden") })
  outside.on("upgrade", (request, socket) => { forbidden.push(`ws:${request.url}`); socket.destroy() })
  await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve))
  const outsideAddress = outside.address()
  assert.ok(outsideAddress && typeof outsideAddress !== "string")
  const denied = `http://127.0.0.1:${outsideAddress.port}`
  const attack = `
    const source = ${JSON.stringify(`fetch('${denied}/worker');new WebSocket('${denied.replace("http:", "ws:")}/worker')`)};
    const urls = ['/worker.js', URL.createObjectURL(new Blob([source],{type:'application/javascript'})), 'data:text/javascript,'+encodeURIComponent(source)];
    let blocked=0;
    for(const kind of ['Worker','SharedWorker']) for(const url of urls) {try {new globalThis[kind](url)} catch(e) {blocked++}}
    if(!navigator.serviceWorker) blocked++;
    try {Object.defineProperty(globalThis,'Worker',{value: class {}})} catch(e) {blocked++}
    parent.postMessage({proof:location.hash || location.pathname,blocked},'*');
    new WebSocket('${denied.replace("http:", "ws:")}/frame');
  `
  const html = `<script>${attack}</script>`
  const server = createServer((request, response) => {
    if (request.url === "/worker.js") { attempts.push(request.url); response.setHeader("Content-Type", "application/javascript"); response.end(`fetch('${denied}/worker')`); return }
    response.setHeader("Content-Type", "text/html")
    response.setHeader("Content-Security-Policy", "object-src 'none'")
    if (request.url !== "/") { response.end(html); return }
    response.end(`<script>
      globalThis.proofs=[];onmessage=e=>{if(e.data?.proof)proofs.push(e.data)};
      ${attack}
      for(const url of ['/frame#same', 'http://127.0.0.2:${(server.address() as { port: number }).port}/frame#cross', 'data:text/html,'+encodeURIComponent(${JSON.stringify(html).replaceAll("<", "\\u003c")})+'#data', URL.createObjectURL(new Blob([${JSON.stringify(html).replaceAll("<", "\\u003c")}],{type:'text/html'}))+'#blob']) {const f=document.createElement('iframe');f.src=url;document.documentElement.append(f)}
      const f=document.createElement('iframe');f.srcdoc=${JSON.stringify(html).replaceAll("<", "\\u003c")};document.documentElement.append(f);
      setTimeout(()=>{${attack.replaceAll("const ", "var ").replaceAll("let ", "var ")}},100);
      const ws=new WebSocket(location.origin.replace('http:','ws:')+'/hmr');ws.onopen=()=>{globalThis.hmr=true;ws.close()};
    </script>`)
  })
  server.on("upgrade", (request, socket) => {
    allowed.push(request.url!)
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on("data", () => socket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ["--site-per-process"] })
  try {
    const context = await browser.newContext({ serviceWorkers: "block" })
    const logs: string[] = []
    await BrowserNetwork.install(context, new Set([`http://127.0.0.1:${address.port}`, `http://127.0.0.2:${address.port}`]), (text) => logs.push(text))
    const page = await context.newPage()
    const response = await page.goto(`http://127.0.0.1:${address.port}`)
    assert.match(response!.headers()["content-security-policy"], /object-src 'none'.*worker-src 'none'/)
    await page.waitForFunction("globalThis.proofs?.length >= 7 && globalThis.hmr === true", undefined, { timeout: 10000 })
    const proofs = await page.evaluate("proofs") as { proof: string; blocked: number }[]
    assert.ok(proofs.every((proof) => proof.blocked === 8), JSON.stringify(proofs))
    assert.deepEqual(forbidden, [])
    assert.deepEqual(attempts, [])
    assert.deepEqual(allowed, ["/hmr"])
    assert.ok(logs.some((text) => text.includes("Blocked WebSocket")))
    console.log(JSON.stringify({ proofs, forbidden, workerScriptArrivals: attempts, authorizedSockets: allowed }))
  } finally {
    await browser.close()
    server.closeAllConnections(); outside.closeAllConnections()
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => outside.close(() => resolve()))])
  }
})

