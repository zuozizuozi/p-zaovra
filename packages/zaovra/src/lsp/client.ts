export * as LSPClient from "./client"

import { LSPClient } from "@zaovra-ai/core/lsp/client"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import type { InstanceContext } from "@/project/instance-context"

export type Info = LSPClient.Info
export type Diagnostic = LSPClient.Diagnostic
export const InitializeError = LSPClient.InitializeError

export function create(input: Omit<Parameters<typeof LSPClient.create>[0], "runtime"> & { instance: InstanceContext }) {
  return LSPClient.create({
    ...input,
    runtime: {
      normalizePath: Filesystem.normalizePath,
      readText: Filesystem.readText,
      stop: () => Process.stop(input.server.process),
    },
  })
}
