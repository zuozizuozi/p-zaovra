import { build } from 'vite'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { strictEqual } from 'node:assert'

const root = resolve(import.meta.dir, '..')
const destination = resolve(root, '../../website-preview')
const result = await build({
  configFile: false,
  root,
  publicDir: false,
  plugins: [{
    name: 'standalone-dom-order',
    transform(code, id) {
      if (!/\/src\/(details|atmosphere)\.js$/.test(id.replaceAll('\\', '/'))) return
      // Inlining dynamic imports otherwise runs their DOM setup before main creates the page.
      const imports = code.match(/^import .+$/gm) || []
      return `${imports.join('\n')}\nqueueMicrotask(() => {\n${code.replace(/^import .+$/gm, '')}\n})`
    },
  }],
  build: {
    write: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(root, 'src/main.js'),
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
})

const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output)
const scripts = outputs.filter(item => item.type === 'chunk')
strictEqual(scripts.length, 1, 'Preview must contain a single JavaScript bundle')
const css = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.source).join('\n')
let html = (await Bun.file(resolve(root, 'index.html')).text())
  .replace('<script type="module" src="/src/main.js"></script>', () => `<script>${scripts[0].code.replaceAll('</script', '<\\/script')}</script>`)
  .replace('</head>', () => `<style>${css.replaceAll('</style', '<\\/style')}</style></head>`)

const resources = [...new Set(html.match(/\/(?:assets|fonts)\/[a-zA-Z0-9_.-]+/g) || [])]
for (const resource of resources) {
  const file = Bun.file(resolve(root, `public${resource}`))
  if (!await file.exists()) throw new Error(`Missing preview resource: ${resource}`)
  const data = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`
  html = html.replaceAll(resource, data)
}
strictEqual(/(?:src|href)=["']\/(?:assets|fonts|src)\//.test(html), false, 'Unbundled local resource')
strictEqual(/\bimport\s*\(/.test(html), false, 'Preview must not load JavaScript chunks')
await mkdir(destination, { recursive: true })
await Bun.write(resolve(destination, 'Zaovra-preview.html'), html)
console.log(`Standalone preview: ${destination}/Zaovra-preview.html (${(Buffer.byteLength(html)/1024/1024).toFixed(2)} MB)`)
