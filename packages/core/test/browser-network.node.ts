import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { chromium } from "playwright-core"
import { BrowserNetwork } from "../src/tool/browser-network"

test(
  "workers are disabled before scripts in inherited and cross-origin frames; main-thread sockets remain authorized",
  { timeout: 30000 },
  async () => {
    const forbidden: string[] = []
    const attempts: string[] = []
    const allowed: string[] = []
    const outside = createServer((request, response) => {
      forbidden.push(request.url!)
      response.end("forbidden")
    })
    outside.on("upgrade", (request, socket) => {
      forbidden.push(`ws:${request.url}`)
      socket.destroy()
    })
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
    fetch('${denied}/frame-http').catch(()=>{});
  `
    const html = `<script>${attack}</script>`
    const server = createServer((request, response) => {
      if (request.url === "/worker.js") {
        attempts.push(request.url)
        response.setHeader("Content-Type", "application/javascript")
        response.end(`fetch('${denied}/worker')`)
        return
      }
      response.setHeader("Content-Type", "text/html")
      response.setHeader("Content-Security-Policy", "object-src 'none'")
      if (request.url !== "/") {
        response.end(html)
        return
      }
      response.end(`<script>
      globalThis.proofs=[];onmessage=e=>{if(e.data?.proof)proofs.push(e.data)};
      ${attack}
      for(const url of ['/frame#same', 'http://localhost:${(server.address() as { port: number }).port}/frame#cross', 'data:text/html,'+encodeURIComponent(${JSON.stringify(html).replaceAll("<", "\\u003c")})+'#data', URL.createObjectURL(new Blob([${JSON.stringify(html).replaceAll("<", "\\u003c")}],{type:'text/html'}))+'#blob']) {const f=document.createElement('iframe');f.src=url;document.documentElement.append(f)}
      const f=document.createElement('iframe');f.srcdoc=${JSON.stringify(html).replaceAll("<", "\\u003c")};document.documentElement.append(f);
      const blank=document.createElement('iframe');document.documentElement.append(blank);
      let inherited=false;try {new blank.contentWindow.Worker('/worker.js')}catch(e){inherited=true}
      proofs.push({proof:'synchronous-about-blank',blocked:inherited?8:0});
      setTimeout(()=>{${attack.replaceAll("const ", "var ").replaceAll("let ", "var ")}},100);
      const ws=new WebSocket(location.origin.replace('http:','ws:')+'/hmr');ws.onopen=()=>{globalThis.hmr=true;ws.close()};
      new WebSocket(location.origin.replace('http:','ws:')+'/ws-redirect');
    </script>`)
    })
    server.on("upgrade", (request, socket) => {
      allowed.push(request.url!)
      if (request.url === "/ws-redirect") {
        socket.end(
          `HTTP/1.1 302 Found\r\nLocation: ${denied.replace("http:", "ws:")}/redirected-socket\r\nContent-Length: 0\r\n\r\n`,
        )
        return
      }
      const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64")
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      socket.on("data", () => socket.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ["--site-per-process"] })
    try {
      const context = await browser.newContext({ serviceWorkers: "block" })
      const logs: string[] = []
      const browserErrors: string[] = []
      const network = await BrowserNetwork.install(
        context,
        new Set([`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`]),
        (text) => logs.push(text),
      )
      const page = await context.newPage()
      await network.stream(page)
      page.on("requestfailed", (request) => console.log("requestfailed", request.url(), request.failure()))
      page.on("console", (message) => {
        if (message.type() === "error") {
          browserErrors.push(message.text())
          console.log("browsererror", message.text())
        }
      })
      const response = await page.goto(`http://127.0.0.1:${address.port}`)
      assert.match(response!.headers()["content-security-policy"], /object-src 'none'[\s\S]*worker-src 'none'/)
      await page.waitForFunction("globalThis.proofs?.length >= 8 && globalThis.hmr === true", undefined, {
        timeout: 10000,
      })
      const proofs = (await page.evaluate("proofs")) as { proof: string; blocked: number }[]
      await page.waitForTimeout(200)
      assert.ok(
        proofs.every((proof) => proof.blocked === 8),
        JSON.stringify(proofs),
      )
      assert.deepEqual(forbidden, [])
      assert.deepEqual(attempts, [])
      assert.deepEqual(allowed.sort(), ["/hmr", "/ws-redirect"])
      assert.ok(logs.some((text) => text.includes("Blocked WebSocket")))
      assert.ok(
        logs.some((text) => text.includes("iframe guard installed")),
        JSON.stringify(logs),
      )
      console.log(JSON.stringify({ proofs, forbidden, workerScriptArrivals: attempts, authorizedSockets: allowed }))
    } finally {
      await browser.close()
      server.closeAllConnections()
      outside.closeAllConnections()
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => outside.close(() => resolve())),
      ])
    }
  },
)

test(
  "native SSE and read streams exceed ten seconds; redirects, uncertain effects and closure are bounded",
  { timeout: 30000 },
  async () => {
    const hits: string[] = []
    const denied: string[] = []
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let closed = false
    const outside = createServer((request, response) => {
      denied.push(request.url!)
      response.end("denied")
    })
    await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve))
    const other = outside.address()
    assert.ok(other && typeof other !== "string")
    const server = createServer((request, response) => {
      hits.push(`${request.method} ${request.url}`)
      response.setHeader("Access-Control-Allow-Origin", "*")
      if (request.url === "/sse" || request.url === "/stream") {
        response.writeHead(200, {
          "Content-Type": request.url === "/sse" ? "text/event-stream" : "text/plain",
          "Cache-Control": "no-cache",
        })
        response.write(request.url === "/sse" ? "data: first\n\n" : "first\n")
        const timer = setTimeout(() => {
          timers.delete(timer)
          response.end(request.url === "/sse" ? "data: last\n\n" : "last\n")
        }, 11000)
        timers.add(timer)
        return
      }
      if (request.url === "/stop") {
        response.writeHead(200)
        response.write("first")
        response.on("close", () => {
          closed = true
        })
        return
      }
      if (request.url === "/uncertain") {
        response.destroy()
        return
      }
      if (request.url?.startsWith("/loop/")) {
        response.writeHead(302, { location: `/loop/${Number(request.url.split("/").at(-1)) + 1}` })
        response.end()
        return
      }
      if (request.url?.startsWith("/cross-loop/")) {
        response.writeHead(302, {
          location: `http://${request.headers.host?.startsWith("localhost") ? "127.0.0.1" : "localhost"}:${(server.address() as { port: number }).port}/cross-loop/${Number(request.url.split("/").at(-1)) + 1}`,
        })
        response.end()
        return
      }
      if (
        request.url === "/redirect" ||
        request.url === "/post" ||
        request.url === "/post303" ||
        request.url === "/outside"
      ) {
        response.writeHead(request.url === "/post" ? 307 : request.url === "/post303" ? 303 : 302, {
          location:
            request.url === "/outside"
              ? `http://127.0.0.1:${other.port}/denied`
              : request.url === "/redirect"
                ? "/ok"
                : "/replayed",
        })
        response.end()
        return
      }
      response.setHeader("Content-Type", "text/html")
      response.end("<title>Streaming</title><p>ready</p>")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true })
    try {
      const context = await browser.newContext({ serviceWorkers: "block" })
      const logs: string[] = []
      const browserErrors: string[] = []
      const network = await BrowserNetwork.install(
        context,
        new Set([`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`]),
        (text) => logs.push(text),
      )
      const page = await context.newPage()
      await network.stream(page)
      page.on("requestfailed", (request) => console.log("requestfailed", request.url(), request.failure()))
      page.on("console", (message) => {
        if (message.type() === "error") {
          browserErrors.push(message.text())
          console.log("browsererror", message.text())
        }
      })
      await page.goto(`http://127.0.0.1:${address.port}`)
      const result = await page.evaluate(async () => {
        const start = performance.now()
        const sse = new Promise<{ first: number; last: number }>((resolve, reject) => {
          let first = 0
          const events: EventSource = Reflect.construct(EventSource, ["/sse"])
          events.onmessage = (event) => {
            if (event.data === "first") first = performance.now() - start
            if (event.data === "last") {
              events.close()
              resolve({ first, last: performance.now() - start })
            }
          }
          events.onerror = () => {
            events.close()
            reject(new Error("SSE failed"))
          }
        })
        const stream = (async () => {
          const response = await fetch("/stream")
          const reader = response.body!.getReader()
          await reader.read()
          const first = performance.now() - start
          while (!(await reader.read()).done) {}
          return { first, last: performance.now() - start }
        })()
        return Promise.all([sse, stream])
      })
      assert.ok(
        result.every((item) => item.first < 1000 && item.last >= 10500 && item.first < item.last),
        JSON.stringify(result),
      )
      const redirects = await page.evaluate(async () => {
        const results: Record<string, boolean> = {}
        for (const [url, method] of [
          ["/redirect", "GET"],
          ["/post", "POST"],
          ["/post303", "POST"],
          ["/outside", "GET"],
          ["/loop/0", "GET"],
          ["/cross-loop/0", "GET"],
          ["/uncertain", "POST"],
        ])
          results[url] = await fetch(url, { method }).then(
            (response) => response.ok,
            () => false,
          )
        return results
      })
      console.log(JSON.stringify({ hits, logs, redirects }))
      assert.deepEqual(redirects, {
        "/redirect": true,
        "/post": false,
        "/post303": false,
        "/outside": false,
        "/loop/0": false,
        "/cross-loop/0": false,
        "/uncertain": false,
      })
      assert.deepEqual(denied, [])
      assert.equal(hits.filter((hit) => hit.includes("/replayed")).length, 0)
      assert.equal(hits.filter((hit) => hit === "POST /uncertain").length, 1)
      assert.equal(hits.filter((hit) => hit === "GET /stream").length, 1)
      assert.ok(hits.filter((hit) => hit.includes("/loop/")).length <= 9)
      const crossHops = hits.filter((hit) => hit.includes("/cross-loop/")).length
      assert.ok(
        crossHops === 9 ||
          (crossHops === 1 && browserErrors.some((text) => text.includes("cross-loop") && text.includes("loopback"))),
        JSON.stringify({ crossHops, browserErrors }),
      )
      console.log(
        JSON.stringify({
          crossOriginHopCoverage: crossHops === 9 ? "guard-limit" : "blocked-earlier-by-Chromium-local-network-policy",
        }),
      )
      await page.evaluate(async () => {
        const response = await fetch("/stop")
        await response.body!.getReader().read()
      })
      const stop = Date.now()
      await browser.close()
      while (!closed && Date.now() - stop < 1000) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(closed)
      assert.equal(hits.filter((hit) => hit === "GET /stop").length, 1)
      console.log(JSON.stringify({ streams: result, redirects, denied, stopMs: Date.now() - stop, hits }))
    } finally {
      await browser.close()
      timers.forEach(clearTimeout)
      server.closeAllConnections()
      outside.closeAllConnections()
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => outside.close(() => resolve())),
      ])
    }
  },
)
