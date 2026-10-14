import { Glob } from "@zaovra-ai/core/util/glob"
import { ConfigPluginV1 } from "@zaovra-ai/core/v1/config/plugin"
import { pathToFileURL, fileURLToPath } from "url"
import { isPathPluginSpec, parsePluginSpecifier, resolvePathPluginTarget } from "@/plugin/shared"
import path from "path"
import { Filesystem } from "@/util/filesystem"

export type Scope = "global" | "local"

export async function hasLocalSource(dir: string, plugins: Origin[] = []) {
  for (const plugin of plugins) {
    if (!isPathPluginSpec(pluginSpecifier(plugin.spec))) continue
    const spec = pluginSpecifier(await resolvePluginSpec(plugin.spec, plugin.source))
    const file = fileURLToPath(spec)
    const relative = path.relative(dir, file)
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue
    const target = await resolvePathPluginTarget(spec).catch(() => undefined)
    if (target && (await Filesystem.exists(fileURLToPath(target)))) return true
  }
  return (
    (
      await Glob.scan("{plugin,plugins,tool,tools}/**/*.{ts,js,mts,mjs,cts,cjs}", {
        cwd: dir,
        dot: true,
        symlink: true,
      })
    ).length > 0
  )
}

// Origin keeps the original config provenance attached to a spec.
// After multiple config files are merged, callers still need to know which file declared the plugin
// and whether it should behave like a global or project-local plugin.
export type Origin = {
  spec: ConfigPluginV1.Spec
  source: string
  scope: Scope
}

export async function load(dir: string) {
  const plugins: ConfigPluginV1.Spec[] = []

  for (const item of await Glob.scan("{plugin,plugins}/*.{ts,js}", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    plugins.push(pathToFileURL(item).href)
  }
  return plugins
}

export function pluginSpecifier(plugin: ConfigPluginV1.Spec): string {
  return Array.isArray(plugin) ? plugin[0] : plugin
}

export function pluginOptions(plugin: ConfigPluginV1.Spec): ConfigPluginV1.Options | undefined {
  return Array.isArray(plugin) ? plugin[1] : undefined
}

// Path-like specs are resolved relative to the config file that declared them so merges later on do not
// accidentally reinterpret `./plugin.ts` relative to some other directory.
export async function resolvePluginSpec(
  plugin: ConfigPluginV1.Spec,
  configFilepath: string,
): Promise<ConfigPluginV1.Spec> {
  const spec = pluginSpecifier(plugin)
  if (!isPathPluginSpec(spec)) return plugin

  const base = path.dirname(configFilepath)
  const file = (() => {
    if (spec.startsWith("file://")) return spec
    if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return pathToFileURL(spec).href
    return pathToFileURL(path.resolve(base, spec)).href
  })()

  const resolved = await resolvePathPluginTarget(file).catch(() => file)

  if (Array.isArray(plugin)) return [resolved, plugin[1]]
  return resolved
}

// Dedupe on the load identity (package name for npm specs, exact file URL for local specs), but keep the
// full Origin so downstream code still knows which config file won and where follow-up writes should go.
export function deduplicatePluginOrigins(plugins: Origin[]): Origin[] {
  const seen = new Set<string>()
  const list: Origin[] = []

  for (const plugin of plugins.toReversed()) {
    const spec = pluginSpecifier(plugin.spec)
    const name = spec.startsWith("file://") ? spec : parsePluginSpecifier(spec).pkg
    if (seen.has(name)) continue
    seen.add(name)
    list.push(plugin)
  }

  return list.toReversed()
}

export * as ConfigPlugin from "./plugin"
